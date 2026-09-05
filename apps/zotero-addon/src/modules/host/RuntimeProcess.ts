import {
  resolveRuntimeLaunch,
  type RuntimeExecutableKind,
} from "./RuntimeDiscovery";
export { resolveRuntimeExecutable } from "./RuntimeDiscovery";
export type { RuntimeExecutableKind } from "./RuntimeDiscovery";

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
  getEnvironment(): Record<string, string>;
}

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

export async function runRuntimeCommand(
  requested: string,
  kind: RuntimeExecutableKind,
  args: string[],
  timeoutMs = 15_000,
): Promise<RuntimeCommandResult> {
  const { executable, environment } = await resolveRuntimeLaunch(
    requested,
    kind,
  );
  const process = await subprocess().call({
    command: executable,
    arguments: args,
    environment: runtimeEnvironment(environment),
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
      Promise.all([process.wait(), stdoutPromise, stderrPromise]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${runtimeLabel(kind)} command timed out at ${executable}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
    const [{ exitCode }, stdout, stderr] = result;
    if (exitCode !== 0) {
      throw new Error(
        `${runtimeLabel(kind)} exited (${exitCode})${
          stderr.trim() ? `: ${stderr.trim()}` : ""
        }`,
      );
    }
    return { executable, stdout, stderr, exitCode };
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
    environmentOverrides: Record<string, string> = {},
  ): Promise<RuntimeJsonLineProcess> {
    const { executable, environment } = await resolveRuntimeLaunch(
      requested,
      kind,
    );
    const process = await subprocess().call({
      command: executable,
      arguments: args,
      environment: runtimeEnvironment({
        ...environment,
        ...environmentOverrides,
      }),
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

function runtimeLabel(kind: RuntimeExecutableKind): string {
  return kind === "codex" ? "Codex" : "Kimi";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function runtimeEnvironment(
  environment: Record<string, string | null>,
): Record<string, string | null> {
  if (Services.appinfo.OS !== "WINNT") return environment;
  const merged = { ...environment };
  // Windows variables are case-insensitive; Gecko's environment object is not.
  // Remove inherited Path/path variants before appending our canonical PATH.
  for (const key of Object.keys(subprocess().getEnvironment())) {
    if (key.toLowerCase() === "path" && key !== "PATH") merged[key] = null;
  }
  return merged;
}
