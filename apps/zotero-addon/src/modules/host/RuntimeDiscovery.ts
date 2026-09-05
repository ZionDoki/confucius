export type RuntimeExecutableKind = "codex" | "kimi";

export interface RuntimeLaunch {
  executable: string;
  environment: Record<string, string | null>;
}

/** Resolve files without executing a login shell, npm, or a Windows command shim. */
export async function resolveRuntimeLaunch(
  requested: string,
  kind: RuntimeExecutableKind,
): Promise<RuntimeLaunch> {
  const home = homeDirectory();
  const configured = expandPath(requested, home);
  const directories = await runtimeSearchDirectories(home);
  const automatic =
    !configured || commandNames(kind).includes(configured.toLowerCase());
  let candidates: string[];
  if (configured && PathUtils.isAbsolute(configured)) {
    candidates =
      isMac() && /\.app\/?$/i.test(configured) && kind === "codex"
        ? [PathUtils.join(configured, "Contents", "Resources", "codex")]
        : [configured];
  } else if (configured && /[/\\]/.test(configured)) {
    throw new Error(
      `${label(kind)} requires an absolute executable path; relative paths and shell commands are not supported.`,
    );
  } else {
    candidates = automatic
      ? await automaticRuntimeCandidates(kind, home, directories)
      : directories.flatMap((directory) =>
          commandNames(configured).map((name) =>
            PathUtils.join(directory, name),
          ),
        );
  }

  const failures: string[] = [];
  for (const candidate of uniquePaths(candidates)) {
    try {
      if (!(await IOUtils.exists(candidate))) continue;
      const executable = await resolveCandidate(candidate, kind);
      // Keep the selected launcher's directory for Python/uv and package-manager
      // helpers, as well as the native binary's directory. Never add the cwd.
      const searchPath = uniquePaths([
        PathUtils.parent(executable),
        PathUtils.parent(candidate),
        ...directories,
      ]);
      const environment: RuntimeLaunch["environment"] = {
        PATH: searchPath.join(isWindows() ? ";" : ":"),
      };
      if (home && !environmentValue("HOME") && !isWindows())
        environment.HOME = home;
      if (kind === "kimi") {
        environment.PYTHONUTF8 = "1";
        environment.PYTHONIOENCODING = "utf-8";
      }
      return { executable, environment };
    } catch (error) {
      // On macOS, PathUtils.normalize performs real filesystem access and can
      // throw for missing directories, broken symlinks, or denied permissions.
      // A bad optional candidate must never prevent checking the next one.
      if (failures.length < 3)
        failures.push(`${candidate}: ${errorMessage(error)}`);
    }
  }
  const detail = failures.length ? ` ${failures.join("; ")}` : "";
  throw new Error(
    `${label(kind)} executable ${configured && !automatic ? `was not usable at ${configured}` : "was not found"}.${detail} Select an installed executable in Confucius settings, or clear the path to detect it again.`,
  );
}

export async function resolveRuntimeExecutable(
  requested: string,
  kind: RuntimeExecutableKind,
): Promise<string> {
  return (await resolveRuntimeLaunch(requested, kind)).executable;
}

async function resolveCandidate(
  candidate: string,
  kind: RuntimeExecutableKind,
): Promise<string> {
  // Normalize only existing candidates. Besides removing .., Gecko follows the
  // symlink from a Homebrew/npm/pnpm launcher into its actual package directory.
  const found = PathUtils.normalize(candidate);
  const stat = await IOUtils.stat(found);
  if (stat.type === "directory")
    throw new Error("This path is a directory, not an executable file");
  if (
    !isWindows() &&
    stat.permissions !== undefined &&
    !(stat.permissions & 0o111)
  ) {
    throw new Error("The file does not have execute permission");
  }
  // Reading the prefix must stay bounded even for a 200 MB standalone binary.
  const prefix = new TextDecoder().decode(
    await IOUtils.read(found, { maxBytes: 512 }),
  );
  const script =
    prefix.startsWith("#!") || /\.(?:js|mjs|cjs|cmd|bat|ps1)$/i.test(found);
  if (kind === "codex" && script) {
    const binary = await findPackagedCodexBinary(found, candidate);
    if (binary && PathUtils.normalize(binary) !== found)
      return resolveCandidate(binary, kind);
    if (
      /\b(?:node|nodejs)\b/.test(prefix) ||
      /\.(?:js|mjs|cjs|cmd|bat|ps1)$/i.test(found)
    ) {
      throw new Error(
        "The Codex launcher is installed but its platform binary is missing. Reinstall Codex with its optional platform dependencies, or select a standalone Codex executable",
      );
    }
  }
  if (isWindows() && !/\.(?:exe|com)$/i.test(found)) {
    throw new Error(
      "Select the native .exe file; .cmd, .bat and PowerShell launchers cannot be started directly by Zotero",
    );
  }
  // pip/uv/pipx entry points are executable Python scripts on Unix. Their
  // interpreter can go missing after a Python update; do not hide that cause.
  const interpreter = prefix.startsWith("#!")
    ? prefix.slice(2).split(/\r?\n/, 1)[0].trim().split(/\s+/, 1)[0]
    : "";
  if (
    !isWindows() &&
    interpreter &&
    PathUtils.isAbsolute(interpreter) &&
    !(await IOUtils.exists(interpreter))
  ) {
    throw new Error(
      `The script interpreter is missing: ${interpreter}. Reinstall this CLI or select its standalone binary`,
    );
  }
  return found;
}

async function findPackagedCodexBinary(
  ...launchers: string[]
): Promise<string | null> {
  const target = codexTarget();
  if (!target) return null;
  const executable = isWindows() ? "codex.exe" : "codex";
  const packages: string[] = [];
  for (const launcher of launchers) {
    let cursor = PathUtils.parent(launcher);
    for (let depth = 0; cursor && depth < 10; depth++) {
      packages.push(
        cursor,
        PathUtils.join(cursor, `codex-${target.packageSuffix}`),
      );
      for (const nodeModules of [
        PathUtils.join(cursor, "node_modules"),
        PathUtils.join(cursor, "lib", "node_modules"),
      ]) {
        packages.push(
          PathUtils.join(
            nodeModules,
            "@openai",
            `codex-${target.packageSuffix}`,
          ),
          PathUtils.join(nodeModules, "@openai", "codex"),
          PathUtils.join(
            nodeModules,
            "@openai",
            "codex",
            "node_modules",
            "@openai",
            `codex-${target.packageSuffix}`,
          ),
        );
      }
      const parent = PathUtils.parent(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  for (const root of uniquePaths(packages)) {
    // Older CLI releases used vendor/<target>/codex/codex; current packages
    // use vendor/<target>/bin/codex, both nested and hoisted by npm/pnpm/bun.
    for (const directory of ["bin", "codex"]) {
      const binary = PathUtils.join(
        root,
        "vendor",
        target.triple,
        directory,
        executable,
      );
      if (await exists(binary)) return binary;
    }
  }
  return null;
}

function codexTarget(): { packageSuffix: string; triple: string } | null {
  const abi = String(Services.appinfo.XPCOMABI ?? "").toLowerCase();
  const arm = /aarch64|arm64/.test(abi);
  if (!arm && !/x86_64|amd64|x64/.test(abi)) return null;
  if (isWindows())
    return {
      packageSuffix: `win32-${arm ? "arm64" : "x64"}`,
      triple: `${arm ? "aarch64" : "x86_64"}-pc-windows-msvc`,
    };
  if (isMac())
    return {
      packageSuffix: `darwin-${arm ? "arm64" : "x64"}`,
      triple: `${arm ? "aarch64" : "x86_64"}-apple-darwin`,
    };
  if (Services.appinfo.OS === "Linux")
    return {
      packageSuffix: `linux-${arm ? "arm64" : "x64"}`,
      triple: `${arm ? "aarch64" : "x86_64"}-unknown-linux-musl`,
    };
  return null;
}

async function automaticRuntimeCandidates(
  kind: RuntimeExecutableKind,
  home: string,
  directories: string[],
): Promise<string[]> {
  const candidates = directories.flatMap((directory) =>
    commandNames(kind).map((name) => PathUtils.join(directory, name)),
  );
  if (isWindows()) {
    const localAppData = windowsDataDirectory("LOCALAPPDATA", "Local", home);
    if (kind === "codex" && localAppData) {
      const desktopBin = PathUtils.join(localAppData, "OpenAI", "Codex", "bin");
      candidates.unshift(
        ...(await childrenNewestFirst(desktopBin)).map((child) =>
          PathUtils.join(child, "codex.exe"),
        ),
        PathUtils.join(desktopBin, "codex.exe"),
      );
    }
    if (kind === "kimi" && home)
      candidates.unshift(PathUtils.join(home, ".kimi-code", "bin", "kimi.exe"));
    candidates.push(...windowsAppPathCandidates(kind));
  } else if (isMac() && kind === "codex") {
    for (const apps of [
      "/Applications",
      ...(home ? [PathUtils.join(home, "Applications")] : []),
    ]) {
      for (const bundle of ["Codex.app", "ChatGPT.app"])
        candidates.push(
          PathUtils.join(apps, bundle, "Contents", "Resources", "codex"),
        );
    }
  }
  return candidates;
}

async function runtimeSearchDirectories(home: string): Promise<string[]> {
  const directories = environmentValue("PATH", "Path").split(
    isWindows() ? ";" : ":",
  );
  const add = (base: string, ...parts: string[]) => {
    if (absolutePath(base)) directories.push(PathUtils.join(base, ...parts));
  };
  for (const name of [
    "NVM_BIN",
    "NVM_SYMLINK",
    "FNM_MULTISHELL_PATH",
    "UV_TOOL_BIN_DIR",
    "PIPX_BIN_DIR",
    "PNPM_HOME",
  ])
    add(environmentPath(name));
  for (const [name, fallback] of [
    ["CARGO_HOME", ".cargo"],
    ["BUN_INSTALL", ".bun"],
    ["VOLTA_HOME", ".volta"],
  ]) {
    add(
      environmentPath(name) || (home ? PathUtils.join(home, fallback) : ""),
      "bin",
    );
  }
  if (home) {
    add(home, ".kimi-code", "bin");
    add(home, ".local", "bin");
    add(home, "bin");
    add(home, ".npm-global", "bin");
    add(home, ".npm", "bin");
    add(home, ".local", "share", "pnpm");
    add(home, ".bun", "install", "global", "node_modules", ".bin");
  }
  for (const name of ["NPM_CONFIG_PREFIX", "npm_config_prefix", "PREFIX"]) {
    const prefix = environmentPath(name);
    if (prefix) add(prefix, ...(isWindows() ? [] : ["bin"]));
  }
  const versionBins = async (root: string, ...suffix: string[]) => {
    for (const child of await childrenNewestFirst(root)) add(child, ...suffix);
  };
  if (isWindows()) {
    const local = windowsDataDirectory("LOCALAPPDATA", "Local", home);
    const roaming = windowsDataDirectory("APPDATA", "Roaming", home);
    add(roaming, "npm");
    add(environmentPath("ProgramFiles", "PROGRAMFILES"), "nodejs");
    add(environmentPath("ProgramFiles(x86)", "PROGRAMFILES(X86)"), "nodejs");
    add(local, "Microsoft", "WinGet", "Links");
    add(local, "pnpm");
    add(home, "scoop", "shims");
    add(environmentPath("SCOOP"), "shims");
    add(environmentPath("SCOOP_GLOBAL"), "shims");
    add(environmentPath("SystemRoot") || "C:\\Windows", "System32");
    if (local) {
      await versionBins(PathUtils.join(local, "Programs", "Python"), "Scripts");
      await versionBins(
        PathUtils.join(local, "pnpm", "global"),
        "node_modules",
        ".bin",
      );
    }
    if (roaming)
      await versionBins(PathUtils.join(roaming, "Python"), "Scripts");
    const nvm = environmentPath("NVM_HOME");
    if (nvm) await versionBins(nvm);
  } else {
    directories.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/home/linuxbrew/.linuxbrew/bin",
    );
    add(home, ".linuxbrew", "bin");
    if (home) {
      const nvm = environmentPath("NVM_DIR") || PathUtils.join(home, ".nvm");
      await versionBins(PathUtils.join(nvm, "versions", "node"), "bin");
      for (const root of [
        PathUtils.join(
          environmentPath("ASDF_DATA_DIR") || PathUtils.join(home, ".asdf"),
          "installs",
          "nodejs",
        ),
        PathUtils.join(
          environmentPath("MISE_DATA_DIR") ||
            PathUtils.join(home, ".local", "share", "mise"),
          "installs",
          "node",
        ),
        PathUtils.join(
          environmentPath("VOLTA_HOME") || PathUtils.join(home, ".volta"),
          "tools",
          "image",
          "node",
        ),
      ])
        await versionBins(root, "bin");
      if (isMac()) {
        add(home, "Library", "pnpm");
        await versionBins(PathUtils.join(home, "Library", "Python"), "bin");
        await versionBins(
          PathUtils.join(home, "Library", "pnpm", "global"),
          "node_modules",
          ".bin",
        );
      }
      await versionBins(
        PathUtils.join(home, ".local", "share", "pnpm", "global"),
        "node_modules",
        ".bin",
      );
    }
  }
  const fnmRoots = [environmentPath("FNM_DIR")];
  if (home) {
    fnmRoots.push(
      PathUtils.join(home, ".fnm"),
      PathUtils.join(home, ".local", "share", "fnm"),
    );
    if (isMac())
      fnmRoots.push(
        PathUtils.join(home, "Library", "Application Support", "fnm"),
      );
  }
  if (isWindows()) {
    const local = windowsDataDirectory("LOCALAPPDATA", "Local", home);
    if (local) fnmRoots.push(PathUtils.join(local, "fnm"));
  }
  for (const root of uniquePaths(fnmRoots))
    await versionBins(
      PathUtils.join(root, "node-versions"),
      "installation",
      ...(isWindows() ? [] : ["bin"]),
    );
  // Do not canonicalize hypothetical paths: on Darwin normalization requires
  // every component to exist. Empty/relative PATH entries also mean cwd.
  return uniquePaths(directories.map((path) => expandPath(path, home)));
}

function windowsAppPathCandidates(kind: RuntimeExecutableKind): string[] {
  const values: string[] = [];
  for (const root of [0x80000001, 0x80000002]) {
    for (const access of [0x20019 | 0x100, 0x20019 | 0x200, 0x20019]) {
      let key: nsIWindowsRegKey | undefined;
      try {
        key = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
          Ci.nsIWindowsRegKey,
        );
        key.open(
          root,
          `Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${kind}.exe`,
          access,
        );
        values.push(expandPath(key.readStringValue(""), homeDirectory()));
      } catch {
        // App Paths is optional and may only be available in one registry view.
      } finally {
        try {
          key?.close();
        } catch {
          /* unopened key */
        }
      }
    }
  }
  return uniquePaths(values);
}

async function childrenNewestFirst(path: string): Promise<string[]> {
  if (!path) return [];
  try {
    const children = await IOUtils.getChildren(path);
    const dated = await Promise.all(
      children.slice(0, 256).map(async (child) => {
        try {
          const stat = await IOUtils.stat(child);
          return stat.type === "directory"
            ? { child, modified: Number(stat.lastModified ?? 0) }
            : null;
        } catch {
          return null;
        }
      }),
    );
    return dated
      .filter(
        (entry): entry is { child: string; modified: number } => entry !== null,
      )
      .sort(
        (a, b) =>
          b.modified - a.modified ||
          b.child.localeCompare(a.child, "en", { numeric: true }),
      )
      .slice(0, 32)
      .map((entry) => entry.child);
  } catch {
    return [];
  }
}

function uniquePaths(paths: (string | null)[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path): path is string => {
    if (!path || !absolutePath(path)) return false;
    const key = isWindows() ? path.replace(/\//g, "\\").toLowerCase() : path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function homeDirectory(): string {
  try {
    const home = absolutePath(Services.dirsvc.get("Home", Ci.nsIFile).path);
    if (home) return home;
  } catch {
    /* Fall back to the process home on hosts without this directory key. */
  }
  return (
    absolutePath(environmentValue("HOME", "USERPROFILE")) ||
    absolutePath(environmentValue("HOMEDRIVE") + environmentValue("HOMEPATH"))
  );
}

function environmentValue(...names: string[]): string {
  for (const name of names) {
    try {
      const value = String(Services.env.get(name) || "");
      if (value) return value;
    } catch {
      /* optional environment entry */
    }
  }
  return "";
}

function absolutePath(path: string): string {
  try {
    return path && PathUtils.isAbsolute(path) ? path : "";
  } catch {
    return "";
  }
}

function environmentPath(...names: string[]): string {
  return absolutePath(expandPath(environmentValue(...names), homeDirectory()));
}

function windowsDataDirectory(
  name: string,
  leaf: string,
  home: string,
): string {
  return (
    absolutePath(expandPath(environmentValue(name), home)) ||
    (home ? PathUtils.join(home, "AppData", leaf) : "")
  );
}

function expandPath(value: string, home: string): string {
  let path = value.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (home && /^~(?:[/\\]|$)/.test(path)) path = home + path.slice(1);
  // Only path-related variables are expanded, without invoking a shell or
  // interpreting command substitutions / arbitrary environment credentials.
  path = path.replace(/\$(?:\{(HOME)\}|(HOME))(?=[/\\]|$)/g, () => home);
  if (isWindows())
    path = path.replace(
      /%(USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|SystemRoot|HOMEDRIVE|HOMEPATH)%/gi,
      (match, name: string) => environmentValue(name.toUpperCase()) || match,
    );
  return path;
}

function commandNames(command: string): string[] {
  return !isWindows() || /\.[a-z0-9]+$/i.test(command)
    ? [command]
    : [`${command}.exe`, `${command}.com`, command, `${command}.cmd`];
}

async function exists(path: string): Promise<boolean> {
  try {
    return await IOUtils.exists(path);
  } catch {
    return false;
  }
}
function isWindows(): boolean {
  return Services.appinfo.OS === "WINNT";
}
function isMac(): boolean {
  return Services.appinfo.OS === "Darwin";
}
function label(kind: RuntimeExecutableKind): string {
  return kind === "codex" ? "Codex" : "Kimi";
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
