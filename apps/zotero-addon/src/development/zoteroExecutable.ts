import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const VARIABLE = "ZOTERO_PLUGIN_ZOTERO_BIN_PATH";
type Environment = Record<string, string | undefined>;

interface DiscoveryOptions {
  platform?: string;
  arch?: string;
  env?: Environment;
  home?: string;
  cwd?: string;
  /** Inject filesystem operations to test native Windows and Unix path rules. */
  isExecutable?: (path: string) => boolean;
  children?: (directory: string) => string[];
  registryPaths?: () => string[];
}

export interface ZoteroExecutable {
  path: string;
  source: "configured" | "PATH" | "installation" | "registry";
}

/** Node-only development support. This module is not imported by the add-on. */
export function resolveZoteroExecutable(
  options: DiscoveryOptions = {},
): ZoteroExecutable {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const arch = options.arch ?? process.arch;
  const path = windows ? win32 : posix;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const executable = windows ? "zotero.exe" : "zotero";
  const get = (...names: string[]): string => {
    for (const name of names) {
      const key = windows
        ? Object.keys(env).find(
            (entry) => entry.toLowerCase() === name.toLowerCase(),
          )
        : name;
      if (key && env[key]) return env[key]!;
    }
    return "";
  };
  const expand = (value: string): string => {
    let expanded = value.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (home && /^~(?:[/\\]|$)/.test(expanded))
      expanded = home + expanded.slice(1);
    expanded = expanded.replace(/\$(?:HOME|\{HOME\})(?=[/\\]|$)/g, home);
    if (windows)
      expanded = expanded.replace(
        /%(USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|ProgramW6432|SystemRoot|SystemDrive)%/gi,
        (match, name: string) => get(name) || match,
      );
    return expanded;
  };
  const isExecutable =
    options.isExecutable ??
    ((candidate: string) => {
      try {
        if (!statSync(candidate).isFile()) return false;
        if (windows) return /\.exe$/i.test(candidate);
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const children =
    options.children ??
    ((directory: string) => {
      try {
        return readdirSync(directory).slice(0, 512);
      } catch {
        return [];
      }
    });
  const checked: string[] = [];
  const seen = new Set<string>();
  const inspect = (
    candidate: string,
    source: ZoteroExecutable["source"],
  ): ZoteroExecutable | undefined => {
    if (!path.isAbsolute(candidate)) return undefined;
    // Keep symlink spelling: launchers such as Snap dispatch using argv[0].
    const normalized = path.normalize(candidate);
    if (windows && !/\.exe$/i.test(normalized)) return undefined;
    const key = windows ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return undefined;
    seen.add(key);
    checked.push(normalized);
    try {
      if (isExecutable(normalized)) return { path: normalized, source };
    } catch {
      /* inaccessible / broken optional candidate */
    }
    return undefined;
  };

  const configured = expand(get(VARIABLE));
  if (configured) {
    const full = path.resolve(cwd, configured);
    const candidates =
      platform === "darwin" && /\.app\/?$/i.test(full)
        ? [path.join(full, "Contents", "MacOS", "zotero")]
        : [full];
    for (const candidate of candidates) {
      const result = inspect(candidate, "configured");
      if (result) return result;
    }
    throw new Error(
      `${VARIABLE} is not an executable Zotero file: ${configured}. Correct this variable in your environment or apps/zotero-addon/.env, or leave it empty for automatic detection.`,
    );
  }

  for (const directory of get("PATH").split(windows ? ";" : ":")) {
    const expanded = expand(directory);
    // npm adds project directories to PATH; never turn empty/relative entries
    // into a search of whichever directory happened to launch the command.
    if (!path.isAbsolute(expanded)) continue;
    const result = inspect(path.join(expanded, executable), "PATH");
    if (result) return result;
  }

  const candidates: string[] = [];
  const add = (base: string, ...parts: string[]) => {
    const expanded = expand(base);
    if (path.isAbsolute(expanded))
      candidates.push(path.join(expanded, ...parts));
  };
  const versioned = (base: string) => {
    if (!path.isAbsolute(base)) return;
    let names: string[];
    try {
      names = children(base);
    } catch {
      return;
    }
    // Only shallow, Zotero-named install entries; no recursive home/drive scan.
    for (const name of names
      .filter((name) => {
        if (!/^zotero(?:$|[-_ .\d])/i.test(name) || /[/\\]/.test(name))
          return false;
        const namedArch = name
          .match(/linux[-_](x86_64|aarch64|arm64)/i)?.[1]
          ?.toLowerCase();
        return (
          !namedArch ||
          (namedArch === "x86_64" ? arch === "x64" : arch === "arm64")
        );
      })
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
      .slice(0, 32)) {
      add(base, name, executable);
    }
  };

  if (platform === "darwin") {
    add("/Applications", "Zotero.app", "Contents", "MacOS", "zotero");
    add(home, "Applications", "Zotero.app", "Contents", "MacOS", "zotero");
  } else if (windows) {
    const drive = get("SystemDrive") || "C:";
    for (const base of [
      get("ProgramW6432"),
      get("ProgramFiles"),
      get("ProgramFiles(x86)"),
      `${drive}\\Program Files`,
      `${drive}\\Program Files (x86)`,
    ])
      add(base, "Zotero", executable);
    const local =
      expand(get("LOCALAPPDATA")) || path.join(home, "AppData", "Local");
    add(local, "Zotero", executable);
    add(local, "Programs", "Zotero", executable);
    add(local, "Microsoft", "WinGet", "Links", executable);
    for (const base of [
      get("SCOOP"),
      path.join(home, "scoop"),
      get("SCOOP_GLOBAL"),
    ]) {
      add(base, "apps", "zotero", "current", executable);
      add(base, "shims", executable);
    }
  } else if (platform === "linux") {
    for (const base of ["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"])
      add(base, executable);
    for (const base of [
      "/opt/zotero",
      "/opt/Zotero",
      "/usr/lib/zotero",
      "/usr/lib64/zotero",
      "/usr/local/lib/zotero",
      "/usr/share/zotero",
      "/usr/local/share/zotero",
    ])
      add(base, executable);
    for (const suffix of [
      [".local", "bin"],
      [".local", "opt", "zotero"],
      [".local", "share", "zotero"],
      ["opt", "zotero"],
    ])
      add(home, ...suffix, executable);
    for (const base of [
      "/opt",
      path.join(home, "Applications"),
      path.join(home, "opt"),
      path.join(home, ".local", "opt"),
    ])
      versioned(base);
  }
  for (const candidate of candidates) {
    const result = inspect(candidate, "installation");
    if (result) return result;
  }
  if (windows) {
    const readRegistry =
      options.registryPaths ?? (() => windowsRegistryPaths(env));
    let entries: string[] = [];
    try {
      entries = readRegistry();
    } catch {
      /* registry unavailable */
    }
    for (const entry of entries) {
      const result = inspect(expand(entry), "registry");
      if (result) return result;
    }
  }
  throw new Error(
    `Zotero executable was not found (${platform}). Install Zotero 7 or later, or set ${VARIABLE} to its executable in apps/zotero-addon/.env. Checked: ${checked.slice(0, 8).join(", ")}${checked.length > 8 ? ` (and ${checked.length - 8} more locations)` : ""}.`,
  );
}

function windowsRegistryPaths(env: Environment): string[] {
  if (process.platform !== "win32") return [];
  const systemRoot =
    Object.entries(env).find(
      ([key]) => key.toLowerCase() === "systemroot",
    )?.[1] || "C:\\Windows";
  const powershell = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  // reg.exe output uses the console code page. Read through .NET and emit UTF-8
  // explicitly so a custom installation path containing Chinese survives pipes.
  const script = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$zoteroEntries = New-Object 'System.Collections.Generic.List[string]'
foreach ($zoteroHive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($zoteroView in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $zoteroBase = $null
    $zoteroKey = $null
    try {
      $zoteroBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey($zoteroHive, $zoteroView)
      $zoteroKey = $zoteroBase.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\zotero.exe')
      if ($null -ne $zoteroKey) {
        $zoteroValue = $zoteroKey.GetValue('')
        if ($zoteroValue -is [string]) { $zoteroEntries.Add($zoteroValue) }
      }
    } catch {} finally {
      if ($null -ne $zoteroKey) { $zoteroKey.Dispose() }
      if ($null -ne $zoteroBase) { $zoteroBase.Dispose() }
    }
  }
}
[Console]::Write((ConvertTo-Json -InputObject @($zoteroEntries.ToArray()) -Compress))
`;
  try {
    const result = execFileSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3_000,
        maxBuffer: 65_536,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const parsed: unknown = JSON.parse(result.replace(/^\uFEFF/, ""));
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
