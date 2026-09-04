export interface RuntimeJsonRpcMessage {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface GeckoPipeInput {
  closed: boolean;
  readString(length?: number | null): Promise<string>;
  close(force?: boolean): Promise<unknown>;
}

interface GeckoPipeOutput {
  closed: boolean;
  write(value: string | Uint8Array): Promise<unknown>;
  close(force?: boolean): Promise<unknown>;
}

interface GeckoProcess {
  pid: number;
  stdin: GeckoPipeOutput;
  stdout: GeckoPipeInput;
  stderr?: GeckoPipeInput;
  wait(): Promise<{ exitCode: number }>;
  kill(timeout?: number): Promise<{ exitCode: number }>;
}

interface GeckoSubprocessModule {
  call(options: {
    command: string;
    arguments?: string[];
    environment?: Record<string, string | null>;
    environmentAppend?: boolean;
    stderr?: "ignore" | "stdout" | "pipe";
    workdir?: string;
  }): Promise<GeckoProcess>;
  pathSearch(
    command: string,
    environment?: Record<string, string>,
  ): Promise<string>;
}

export type RuntimeExecutableKind = "codex" | "kimi";

export interface RuntimeCommandResult {
  executable: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function subprocess(): GeckoSubprocessModule {
  return (
    ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs") as {
      Subprocess: GeckoSubprocessModule;
    }
  ).Subprocess;
}

/**
 * Resolve only an OS-executable entry point. In particular, an npm Codex
 * JavaScript shim is never launched: when one is found we resolve the native
 * platform package beside it or fail with an actionable message.
 */
export async function resolveRuntimeExecutable(
  requested: string,
  kind: RuntimeExecutableKind,
): Promise<string> {
  const configured = requested.trim();
  const command = configured || kind;
  if (PathUtils.isAbsolute(command)) {
    const found = PathUtils.normalize(command);
    if (!(await IOUtils.exists(found))) {
      throw new Error(`${runtimeLabel(kind)} executable does not exist`);
    }
    const executable = await normalizeRuntimeCandidate(found, kind);
    if (executable) return executable;
    throw new Error(
      `${runtimeLabel(kind)} path is not a native executable. Select the official executable file.`,
    );
  }

  // With a blank preference, prefer provider-owned install locations over a
  // stale global shim that happens to appear earlier in PATH.
  if (!configured) {
    for (const candidate of await automaticRuntimeCandidates(kind)) {
      if (!(await IOUtils.exists(candidate))) continue;
      const executable = await normalizeRuntimeCandidate(candidate, kind);
      if (executable) return executable;
    }
  }

  for (const name of commandNames(command)) {
    try {
      const found = await subprocess().pathSearch(name);
      const executable = await normalizeRuntimeCandidate(found, kind);
      if (executable) return executable;
    } catch {
      // Zotero often starts before a CLI installer updates the desktop PATH.
    }
  }

  if (configured && isAutomaticRequest(configured, kind)) {
    for (const candidate of await automaticRuntimeCandidates(kind)) {
      if (!(await IOUtils.exists(candidate))) continue;
      const executable = await normalizeRuntimeCandidate(candidate, kind);
      if (executable) return executable;
    }
  }

  throw new Error(
    `${runtimeLabel(kind)} executable was not found. Select its executable in Confucius settings, or clear the field to use automatic detection.`,
  );
}

export async function runRuntimeCommand(
  requested: string,
  kind: RuntimeExecutableKind,
  args: string[],
  timeoutMs = 8_000,
): Promise<RuntimeCommandResult> {
  const executable = await resolveRuntimeExecutable(requested, kind);
  const process = await subprocess().call({
    command: executable,
    arguments: args,
    environmentAppend: true,
    stderr: "pipe",
  });
  const stdoutPromise = readAll(process.stdout);
  const stderrPromise = process.stderr
    ? readAll(process.stderr)
    : Promise.resolve("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      process.wait(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${runtimeLabel(kind)} command timed out`)),
          timeoutMs,
        );
      }),
    ]);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (result.exitCode !== 0) {
      throw new Error(
        `${runtimeLabel(kind)} exited (${result.exitCode})${
          stderr.trim() ? `: ${stderr.trim()}` : ""
        }`,
      );
    }
    return { executable, stdout, stderr, exitCode: result.exitCode };
  } catch (error) {
    await process.kill(0).catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Newline-delimited JSON-RPC over Gecko's native subprocess pipes. */
export class RuntimeJsonLineProcess {
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly notificationListeners = new Set<
    (message: RuntimeJsonRpcMessage) => void
  >();
  private readonly requestListeners = new Set<
    (message: RuntimeJsonRpcMessage) => void
  >();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private nextId = 1;
  private stderr = "";
  private intentionalClose = false;
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly executable: string,
    private readonly process: GeckoProcess,
  ) {
    void this.readStdout();
    void this.readStderr();
    void process.wait().then(
      ({ exitCode }) => {
        this.failAll(
          new Error(
            `Runtime exited (${exitCode})${
              this.stderr.trim() ? `: ${this.stderr.trim()}` : ""
            }`,
          ),
        );
      },
      (error) => this.failAll(asError(error)),
    );
  }

  static async open(
    requested: string,
    kind: RuntimeExecutableKind,
    args: string[],
    cwd?: string,
  ): Promise<RuntimeJsonLineProcess> {
    const executable = await resolveRuntimeExecutable(requested, kind);
    const process = await subprocess().call({
      command: executable,
      arguments: args,
      environmentAppend: true,
      stderr: "pipe",
      workdir: cwd,
    });
    return new RuntimeJsonLineProcess(executable, process);
  }

  onNotification(
    listener: (message: RuntimeJsonRpcMessage) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: (message: RuntimeJsonRpcMessage) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    try {
      this.send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.pending.delete(id);
      return Promise.reject(asError(error));
    }
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respond(id: string | number | null, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  respondError(
    id: string | number | null,
    code: number,
    message: string,
  ): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  close(): void {
    if (this.intentionalClose) return;
    this.intentionalClose = true;
    void this.process.stdin.close().catch(() => undefined);
    void this.process.kill().catch(() => undefined);
    this.rejectPending(new Error("Runtime connection closed"));
  }

  private send(message: RuntimeJsonRpcMessage): void {
    if (this.intentionalClose || this.process.stdin.closed) {
      throw new Error("Runtime stdin is closed");
    }
    const line = `${JSON.stringify(message)}\n`;
    this.writeQueue = this.writeQueue
      .then(() => this.process.stdin.write(line))
      .catch((error) => {
        this.failAll(asError(error));
      });
  }

  private async readStdout(): Promise<void> {
    let buffered = "";
    try {
      while (!this.process.stdout.closed) {
        const chunk = await this.process.stdout.readString();
        if (!chunk) break;
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline).replace(/\r$/, "");
          buffered = buffered.slice(newline + 1);
          if (line.trim()) this.receive(line);
          newline = buffered.indexOf("\n");
        }
      }
      if (buffered.trim()) this.receive(buffered);
    } catch (error) {
      this.failAll(asError(error));
    }
  }

  private async readStderr(): Promise<void> {
    if (!this.process.stderr) return;
    try {
      while (!this.process.stderr.closed) {
        const chunk = await this.process.stderr.readString();
        if (!chunk) break;
        this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
      }
    } catch {
      // Process exit is reported by wait(); stderr is diagnostic only.
    }
  }

  private receive(line: string): void {
    let message: RuntimeJsonRpcMessage;
    try {
      message = JSON.parse(line) as RuntimeJsonRpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const key = message.id ?? "";
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      if (message.error) {
        const error = new Error(message.error.message || "Runtime RPC error");
        Object.assign(error, {
          code: message.error.code,
          data: message.error.data,
        });
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      for (const listener of this.requestListeners) listener(message);
      return;
    }
    for (const listener of this.notificationListeners) listener(message);
  }

  private failAll(error: Error): void {
    this.rejectPending(error);
    if (this.intentionalClose) return;
    this.intentionalClose = true;
    void this.process.kill(0).catch(() => undefined);
    for (const listener of this.failureListeners) listener(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function readAll(pipe: GeckoPipeInput): Promise<string> {
  let result = "";
  while (!pipe.closed) {
    const chunk = await pipe.readString();
    if (!chunk) break;
    result += chunk;
  }
  return result;
}

async function isNativeExecutable(path: string): Promise<boolean> {
  if (Services.appinfo.OS === "WINNT") {
    return /\.(?:exe|com)$/i.test(path);
  }
  try {
    const stat = await IOUtils.stat(path);
    if (Number(stat.size ?? 0) > 65_536) return true;
    const prefix = await IOUtils.readUTF8(path);
    return !/^#!.*\b(node|nodejs)\b/im.test(prefix.slice(0, 256));
  } catch {
    // Let Subprocess perform the final executable validation.
    return true;
  }
}

async function findPackagedCodexBinary(
  launcherPath: string,
): Promise<string | null> {
  const target = codexTarget();
  if (!target) return null;
  const packageName = `codex-${target.packageSuffix}`;
  const executable = Services.appinfo.OS === "WINNT" ? "codex.exe" : "codex";
  const binarySuffix = ["vendor", target.triple, "bin", executable];
  const roots: string[] = [];
  let cursor = PathUtils.parent(launcherPath);
  for (let index = 0; cursor && index < 7; index++) {
    roots.push(cursor);
    cursor = PathUtils.parent(cursor);
  }
  for (const root of roots) {
    for (const candidate of [
      PathUtils.join(
        root,
        "node_modules",
        "@openai",
        packageName,
        ...binarySuffix,
      ),
      PathUtils.join(
        root,
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        packageName,
        ...binarySuffix,
      ),
      PathUtils.join(root, packageName, ...binarySuffix),
    ]) {
      if (await IOUtils.exists(candidate)) return candidate;
    }
  }
  return null;
}

function codexTarget(): { packageSuffix: string; triple: string } | null {
  const abi = String(Services.appinfo.XPCOMABI ?? "").toLowerCase();
  const arm = abi.includes("aarch64") || abi.includes("arm64");
  if (Services.appinfo.OS === "WINNT") {
    return arm
      ? {
          packageSuffix: "win32-arm64",
          triple: "aarch64-pc-windows-msvc",
        }
      : {
          packageSuffix: "win32-x64",
          triple: "x86_64-pc-windows-msvc",
        };
  }
  if (Services.appinfo.OS === "Darwin") {
    return arm
      ? {
          packageSuffix: "darwin-arm64",
          triple: "aarch64-apple-darwin",
        }
      : {
          packageSuffix: "darwin-x64",
          triple: "x86_64-apple-darwin",
        };
  }
  if (Services.appinfo.OS === "Linux") {
    return arm
      ? {
          packageSuffix: "linux-arm64",
          triple: "aarch64-unknown-linux-musl",
        }
      : {
          packageSuffix: "linux-x64",
          triple: "x86_64-unknown-linux-musl",
        };
  }
  return null;
}

function runtimeLabel(kind: RuntimeExecutableKind): string {
  return kind === "codex" ? "Codex" : "Kimi";
}

function commandNames(command: string): string[] {
  if (Services.appinfo.OS !== "WINNT" || /\.[a-z0-9]+$/i.test(command)) {
    return [command];
  }
  return [`${command}.exe`, command];
}

function isAutomaticRequest(
  configured: string,
  kind: RuntimeExecutableKind,
): boolean {
  return !configured || configured.toLowerCase() === kind;
}

async function normalizeRuntimeCandidate(
  candidate: string,
  kind: RuntimeExecutableKind,
): Promise<string | null> {
  const found = PathUtils.normalize(candidate);
  if (await isNativeExecutable(found)) return found;
  if (kind === "codex") return findPackagedCodexBinary(found);
  return null;
}

async function automaticRuntimeCandidates(
  kind: RuntimeExecutableKind,
): Promise<string[]> {
  const home = directoryPath("Home");
  const localAppData =
    environmentPath("LOCALAPPDATA") ||
    (home && Services.appinfo.OS === "WINNT"
      ? PathUtils.join(home, "AppData", "Local")
      : "");
  const appData =
    environmentPath("APPDATA") ||
    (home && Services.appinfo.OS === "WINNT"
      ? PathUtils.join(home, "AppData", "Roaming")
      : "");
  const candidates: string[] = [];
  const executable = Services.appinfo.OS === "WINNT" ? `${kind}.exe` : kind;

  for (const directory of runtimeSearchDirectories(home, localAppData)) {
    candidates.push(PathUtils.join(directory, executable));
  }

  if (Services.appinfo.OS === "WINNT") {
    if (kind === "codex" && localAppData) {
      const desktopBin = PathUtils.join(localAppData, "OpenAI", "Codex", "bin");
      const versioned = (await childrenNewestFirst(desktopBin)).map((child) =>
        PathUtils.join(child, "codex.exe"),
      );
      candidates.unshift(...versioned, PathUtils.join(desktopBin, "codex.exe"));
    }
    if (kind === "codex" && appData) {
      // npm's launcher itself needs Node, but the pinned Codex package ships a
      // native platform binary beside it. normalizeRuntimeCandidate resolves
      // the latter and never starts the JavaScript launcher.
      candidates.push(PathUtils.join(appData, "npm", "codex.cmd"));
      candidates.push(PathUtils.join(appData, "npm", "codex"));
      const target = codexTarget();
      if (target) {
        candidates.push(
          PathUtils.join(
            appData,
            "npm",
            "node_modules",
            "@openai",
            "codex",
            "node_modules",
            "@openai",
            `codex-${target.packageSuffix}`,
            "vendor",
            target.triple,
            "bin",
            "codex.exe",
          ),
        );
      }
    }
    if (kind === "kimi" && home) {
      candidates.unshift(PathUtils.join(home, ".kimi-code", "bin", "kimi.exe"));
    }
    if (localAppData) {
      candidates.push(
        PathUtils.join(
          localAppData,
          "Microsoft",
          "WinGet",
          "Links",
          executable,
        ),
      );
      if (kind === "kimi") {
        const pythonRoot = PathUtils.join(localAppData, "Programs", "Python");
        for (const child of await safeChildren(pythonRoot)) {
          candidates.push(PathUtils.join(child, "Scripts", "kimi.exe"));
        }
      }
    }
    candidates.push(...windowsAppPathCandidates(kind));
  } else if (Services.appinfo.OS === "Darwin" && kind === "codex") {
    candidates.push(
      "/Applications/Codex.app/Contents/Resources/codex",
      ...(home
        ? [
            PathUtils.join(
              home,
              "Applications",
              "Codex.app",
              "Contents",
              "Resources",
              "codex",
            ),
          ]
        : []),
    );
  }

  return uniquePaths(candidates);
}

function windowsAppPathCandidates(kind: RuntimeExecutableKind): string[] {
  const values: string[] = [];
  const roots = [0x80000001, 0x80000002]; // HKCU, HKLM
  const views = [0x20019 | 0x100, 0x20019 | 0x200, 0x20019];
  const keyPath = `Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${kind}.exe`;
  for (const root of roots) {
    for (const access of views) {
      let key: nsIWindowsRegKey | undefined;
      try {
        key = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
          Ci.nsIWindowsRegKey,
        );
        key.open(root, keyPath, access);
        const value = key.readStringValue("").trim().replace(/^"|"$/g, "");
        if (value) values.push(value);
      } catch {
        // App Paths registration is optional and may exist in only one view.
      } finally {
        try {
          key?.close();
        } catch {
          // Ignore an unopened key.
        }
      }
    }
  }
  return uniquePaths(values);
}

function runtimeSearchDirectories(
  home: string,
  localAppData: string,
): string[] {
  const separator = Services.appinfo.OS === "WINNT" ? ";" : ":";
  const inherited = String(Services.env.get("PATH") || "")
    .split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const defaults = home
    ? [
        PathUtils.join(home, ".kimi-code", "bin"),
        PathUtils.join(home, ".local", "bin"),
        PathUtils.join(home, ".cargo", "bin"),
      ]
    : [];
  if (Services.appinfo.OS === "WINNT" && localAppData) {
    defaults.push(PathUtils.join(localAppData, "Microsoft", "WinGet", "Links"));
  } else {
    defaults.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
  }
  return uniquePaths([...inherited, ...defaults]);
}

function environmentPath(name: string): string {
  try {
    const value = String(Services.env.get(name) || "").trim();
    return value ? PathUtils.normalize(value) : "";
  } catch {
    return "";
  }
}

function directoryPath(key: string): string {
  try {
    return Services.dirsvc.get(key, Ci.nsIFile).path;
  } catch {
    return "";
  }
}

async function safeChildren(path: string): Promise<string[]> {
  if (!path || !(await IOUtils.exists(path))) return [];
  try {
    return await IOUtils.getChildren(path);
  } catch {
    return [];
  }
}

async function childrenNewestFirst(path: string): Promise<string[]> {
  const children = await safeChildren(path);
  const dated = await Promise.all(
    children.map(async (child) => {
      try {
        const stat = await IOUtils.stat(child);
        return {
          child,
          directory: stat.type === "directory",
          modified: Number(stat.lastModified ?? 0),
        };
      } catch {
        return { child, directory: false, modified: 0 };
      }
    }),
  );
  return dated
    .filter((entry) => entry.directory)
    .sort((a, b) => b.modified - a.modified)
    .map((entry) => entry.child);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    if (!path) return false;
    const normalized = PathUtils.normalize(path);
    const key =
      Services.appinfo.OS === "WINNT" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
