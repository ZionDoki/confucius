import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  resolveRuntimeExecutable,
  resolveRuntimeLaunch,
} from "./RuntimeDiscovery";
import { runRuntimeCommand, RuntimeJsonLineProcess } from "./RuntimeProcess";
import { PluginCodexAdapter } from "./PluginCodexAdapter";
import { PluginKimiAdapter } from "./PluginKimiAdapter";

const globals = globalThis as unknown as Record<string, unknown>;
type Entry = {
  path: string;
  type: "regular" | "directory";
  prefix: string;
  permissions: number;
  modified: number;
  target?: string;
};
const files = new Map<string, Entry>();
const inaccessible = new Set<string>();
const env: Record<string, string> = {};
const reads: number[] = [];
let os = "Darwin";
let abi = "aarch64-gcc3";
let home = "/Users/Test";
let paths = posix;
let noHomeService = false;
const calls: Array<Record<string, any>> = [];
let killed = 0;
let processFactory = () => makeProcess();
const key = (value: string) =>
  os === "WINNT"
    ? win32.normalize(value).toLowerCase()
    : posix.normalize(value);

function file(
  path: string,
  prefix = "binary",
  overrides: Partial<Entry> = {},
): string {
  files.set(key(path), {
    path,
    type: "regular",
    prefix,
    permissions: 0o755,
    modified: 0,
    ...overrides,
  });
  let parent = paths.dirname(path);
  while (!files.has(key(parent))) {
    files.set(key(parent), {
      path: parent,
      type: "directory",
      prefix: "",
      permissions: 0o755,
      modified: 0,
    });
    const next = paths.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return path;
}
function symlink(path: string, target: string): string {
  return file(path, "", { target });
}
function canonical(path: string): string {
  if (inaccessible.has(key(path))) throw new Error("Permission denied");
  const entry = files.get(key(path));
  if (!entry) throw new Error("PathUtils.normalize: NS_ERROR_FILE_NOT_FOUND");
  if (entry.target) return canonical(entry.target);
  return entry.path;
}
function setPlatform(platform: string, architecture = "aarch64-gcc3"): void {
  os = platform;
  abi = architecture;
  paths = os === "WINNT" ? win32 : posix;
  home =
    os === "WINNT"
      ? "C:\\Users\\Test"
      : os === "Darwin"
        ? "/Users/Test"
        : "/home/test";
  globals.PathUtils = {
    isAbsolute: paths.isAbsolute,
    normalize: canonical,
    parent: paths.dirname,
    join: (base: string, ...parts: string[]) => {
      if (!paths.isAbsolute(base))
        throw new Error("PathUtils.join requires an absolute base");
      return paths.join(base, ...parts);
    },
  };
}
function output(value: string, hanging = false) {
  return {
    closed: false,
    async close() {
      this.closed = true;
    },
    async readString() {
      if (hanging) return new Promise<string>(() => {});
      this.closed = true;
      return value;
    },
  };
}
function makeProcess(
  stdout = "1.2.3\n",
  stderr = "",
  exitCode = 0,
  hanging = false,
) {
  return {
    pid: 12,
    stdin: {
      closed: false,
      async close() {
        this.closed = true;
      },
      async write(_text: string) {},
    },
    stdout: output(stdout, hanging),
    stderr: output(stderr),
    async wait() {
      return { exitCode };
    },
    async kill() {
      killed++;
      return { exitCode };
    },
  };
}
globals.Services = {
  appinfo: {
    get OS() {
      return os;
    },
    get XPCOMABI() {
      return abi;
    },
  },
  env: {
    get(name: string) {
      return env[name] ?? "";
    },
  },
  dirsvc: {
    get() {
      if (noHomeService) throw new Error("no Home");
      return { path: home };
    },
  },
};
globals.IOUtils = {
  async exists(path: string) {
    if (inaccessible.has(key(path))) throw new Error("Permission denied");
    return files.has(key(path));
  },
  async getChildren(path: string) {
    return [...files.values()]
      .filter(
        (entry) => paths.dirname(entry.path) === path && entry.path !== path,
      )
      .map((entry) => entry.path);
  },
  async stat(path: string) {
    const entry = files.get(key(canonical(path)))!;
    return {
      type: entry.type,
      size: 200_000_000,
      permissions: entry.permissions,
      lastModified: entry.modified,
    };
  },
  async read(path: string, options: { maxBytes: number }) {
    reads.push(options.maxBytes);
    return new TextEncoder()
      .encode(files.get(key(canonical(path)))!.prefix)
      .slice(0, options.maxBytes);
  },
  async makeDirectory() {},
  async createUniqueDirectory(root: string) {
    return `${root}/probe`;
  },
  async remove() {},
};
globals.Zotero = { DataDirectory: { dir: "/zotero-data" } };
globals.Ci = { nsIFile: {} };
globals.ChromeUtils = {
  importESModule() {
    return {
      Subprocess: {
        getEnvironment() {
          return { ...env };
        },
        async call(options: Record<string, unknown>) {
          calls.push(options);
          return processFactory();
        },
      },
    };
  },
};

beforeEach(() => {
  files.clear();
  inaccessible.clear();
  reads.length = 0;
  calls.length = 0;
  killed = 0;
  noHomeService = false;
  for (const name of Object.keys(env)) delete env[name];
  setPlatform("Darwin");
  processFactory = () => makeProcess();
});

describe("Runtime executable discovery", () => {
  it("survives real Gecko normalization of nonexistent macOS candidates (reported regression)", async () => {
    env.PATH = "/missing/homebrew:/old/deleted/bin";
    const kimi = file(`${home}/.kimi-code/bin/kimi`);
    assert.equal(await resolveRuntimeExecutable("", "kimi"), kimi);
    assert.equal(calls.length, 0, "discovery must not run login shells");
  });

  for (const platform of ["Darwin", "Linux", "WINNT"]) {
    it(`finds Kimi without inherited PATH on ${platform}`, async () => {
      setPlatform(platform);
      const kimi = file(
        paths.join(
          home,
          ".kimi-code",
          "bin",
          platform === "WINNT" ? "kimi.exe" : "kimi",
        ),
      );
      assert.equal(await resolveRuntimeExecutable("kimi", "kimi"), kimi);
    });
    it(`honors a quoted Unicode manual path on ${platform}`, async () => {
      setPlatform(platform);
      const manual = file(
        paths.join(home, "Agent 工具", os === "WINNT" ? "kimi.exe" : "kimi"),
      );
      file(
        paths.join(
          home,
          ".kimi-code",
          "bin",
          os === "WINNT" ? "kimi.exe" : "kimi",
        ),
      );
      assert.equal(
        await resolveRuntimeExecutable(`"${manual}"`, "kimi"),
        manual,
      );
    });
    it(`does not substitute an automatic install for a broken manual path on ${platform}`, async () => {
      setPlatform(platform);
      file(
        paths.join(
          home,
          ".kimi-code",
          "bin",
          os === "WINNT" ? "kimi.exe" : "kimi",
        ),
      );
      await assert.rejects(
        resolveRuntimeExecutable(paths.join(home, "missing"), "kimi"),
        /was not usable/,
      );
    });
  }

  for (const bundle of ["Codex.app", "ChatGPT.app"]) {
    it(`finds a macOS ${bundle} CLI after an incomplete npm install`, async () => {
      const launcher = file(
        "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
        "#!/usr/bin/env node\n",
      );
      symlink("/opt/homebrew/bin/codex", launcher);
      const bundled = file(`/Applications/${bundle}/Contents/Resources/codex`);
      assert.equal(await resolveRuntimeExecutable("", "codex"), bundled);
      assert.equal(
        await resolveRuntimeExecutable(`/Applications/${bundle}`, "codex"),
        bundled,
      );
    });
  }

  const platforms = [
    ["Darwin", "aarch64-gcc3", "darwin-arm64", "aarch64-apple-darwin"],
    ["Darwin", "x86_64-gcc3", "darwin-x64", "x86_64-apple-darwin"],
    ["Linux", "aarch64-gcc3", "linux-arm64", "aarch64-unknown-linux-musl"],
    ["Linux", "x86_64-gcc3", "linux-x64", "x86_64-unknown-linux-musl"],
    ["WINNT", "aarch64-msvc", "win32-arm64", "aarch64-pc-windows-msvc"],
    ["WINNT", "x86_64-msvc", "win32-x64", "x86_64-pc-windows-msvc"],
  ];
  for (const [platform, architecture, suffix, triple] of platforms) {
    for (const layout of ["nested", "hoisted", "legacy"]) {
      it(`resolves ${layout} npm Codex for ${suffix}`, async () => {
        setPlatform(platform, architecture);
        const prefix =
          os === "WINNT"
            ? paths.join(home, "AppData", "Roaming", "npm")
            : "/opt/homebrew";
        const nodeModules = paths.join(
          prefix,
          ...(os === "WINNT" ? [] : ["lib"]),
          "node_modules",
        );
        const packageRoot = paths.join(nodeModules, "@openai", "codex");
        const launcher = file(
          paths.join(packageRoot, "bin", "codex.js"),
          "#!/usr/bin/env node\n",
        );
        const shim = paths.join(
          prefix,
          ...(os === "WINNT" ? [] : ["bin"]),
          os === "WINNT" ? "codex.cmd" : "codex",
        );
        if (os === "WINNT")
          file(
            shim,
            '@echo off\r\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js"',
          );
        else symlink(shim, launcher);
        const binaryRoot =
          layout === "legacy"
            ? packageRoot
            : layout === "nested"
              ? paths.join(
                  packageRoot,
                  "node_modules",
                  "@openai",
                  `codex-${suffix}`,
                )
              : paths.join(nodeModules, "@openai", `codex-${suffix}`);
        const binary = file(
          paths.join(
            binaryRoot,
            "vendor",
            triple,
            layout === "legacy" ? "codex" : "bin",
            os === "WINNT" ? "codex.exe" : "codex",
          ),
        );
        assert.equal(await resolveRuntimeExecutable(shim, "codex"), binary);
      });
    }
  }

  it("finds npm behind nvm with no desktop PATH and never requires Node", async () => {
    const root = `${home}/.nvm/versions/node/v24.0.0`;
    const launcher = file(
      `${root}/lib/node_modules/@openai/codex/bin/codex.js`,
      "#!/usr/bin/env node\n",
    );
    symlink(`${root}/bin/codex`, launcher);
    const binary = file(
      `${root}/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`,
    );
    assert.equal(await resolveRuntimeExecutable("", "codex"), binary);
    assert.deepEqual(calls, []);
  });

  for (const relative of [
    "Library/Application Support/fnm/node-versions/v24.0.0/installation/bin",
    ".asdf/installs/nodejs/24.0.0/bin",
    ".local/share/mise/installs/node/24.0.0/bin",
    ".volta/tools/image/node/24.0.0/bin",
  ]) {
    it(`finds a CLI installed under ${relative}`, async () => {
      const binary = file(`${home}/${relative}/codex`);
      assert.equal(await resolveRuntimeExecutable("", "codex"), binary);
    });
  }

  it("follows pnpm links into the versioned package store", async () => {
    const base = `${home}/Library/pnpm/global/5/node_modules`;
    const packageRoot = `${base}/.pnpm/@openai+codex@1.2.3/node_modules/@openai/codex`;
    const launcher = file(
      `${packageRoot}/bin/codex.js`,
      "#!/usr/bin/env node\n",
    );
    symlink(`${base}/.bin/codex`, launcher);
    const binary = file(
      `${packageRoot}/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`,
    );
    assert.equal(await resolveRuntimeExecutable("", "codex"), binary);
  });

  it("supports uv/pipx symlinks and the original Python interpreter", async () => {
    const python = file(`${home}/.local/share/uv/tools/kimi-cli/bin/python`);
    const entry = file(
      `${home}/.local/share/uv/tools/kimi-cli/bin/kimi`,
      `#!${python}\n`,
    );
    symlink(`${home}/.local/bin/kimi`, entry);
    const launch = await resolveRuntimeLaunch("", "kimi");
    assert.equal(launch.executable, entry);
    assert.ok(launch.environment.PATH?.startsWith(paths.dirname(entry)));
    assert.ok(launch.environment.PATH?.includes(`${home}/.local/bin`));
  });

  it("skips a deleted Python interpreter and continues to a healthy Kimi", async () => {
    env.PATH = "/old/bin";
    file("/old/bin/kimi", "#!/missing/python3\n");
    const good = file(`${home}/.kimi-code/bin/kimi`);
    assert.equal(await resolveRuntimeExecutable("", "kimi"), good);
    await assert.rejects(
      resolveRuntimeExecutable("/old/bin/kimi", "kimi"),
      /script interpreter is missing/,
    );
  });

  it("handles an env Python entry point using the enriched child PATH", async () => {
    file("/usr/bin/env");
    file(`${home}/.local/bin/kimi`, "#!/usr/bin/env python3\n");
    const launch = await resolveRuntimeLaunch("", "kimi");
    assert.ok(launch.environment.PATH?.includes("/opt/homebrew/bin"));
    assert.equal(launch.environment.PYTHONUTF8, "1");
  });

  it("finds macOS pip --user installations", async () => {
    const python = file("/opt/homebrew/bin/python3");
    const entry = file(`${home}/Library/Python/3.13/bin/kimi`, `#!${python}\n`);
    assert.equal(await resolveRuntimeExecutable("", "kimi"), entry);
  });

  it("finds Linuxbrew and respects explicit package-manager bin paths", async () => {
    setPlatform("Linux");
    const binary = file("/home/linuxbrew/.linuxbrew/bin/codex");
    assert.equal(await resolveRuntimeExecutable("", "codex"), binary);
    env.UV_TOOL_BIN_DIR = "/custom/uv tools";
    const kimi = file("/custom/uv tools/kimi");
    assert.equal(await resolveRuntimeExecutable("", "kimi"), kimi);
  });

  it("prefers the newest Windows desktop binary", async () => {
    setPlatform("WINNT");
    const root = `${home}\\AppData\\Local\\OpenAI\\Codex\\bin`;
    file(`${root}\\old\\codex.exe`);
    files.get(key(`${root}\\old`))!.modified = 10;
    const binary = file(`${root}\\new\\codex.exe`);
    files.get(key(`${root}\\new`))!.modified = 20;
    assert.equal(await resolveRuntimeExecutable("", "codex"), binary);
  });

  it("discovers Windows pip Scripts and winget links", async () => {
    setPlatform("WINNT");
    const kimi = file(
      `${home}\\AppData\\Local\\Programs\\Python\\Python313\\Scripts\\kimi.exe`,
    );
    assert.equal(await resolveRuntimeExecutable("", "kimi"), kimi);
    const codex = file(
      `${home}\\AppData\\Local\\Microsoft\\WinGet\\Links\\codex.exe`,
    );
    assert.equal(await resolveRuntimeExecutable("", "codex"), codex);
  });

  it("expands a Windows environment path and deduplicates PATH ignoring case", async () => {
    setPlatform("WINNT");
    env.USERPROFILE = home;
    env.Path = `"${home}\\Tools";${home.toLowerCase()}\\tools;.;;relative`;
    const binary = file(`${home}\\Tools\\kimi.exe`);
    const launch = await resolveRuntimeLaunch(
      '"%USERPROFILE%\\Tools\\kimi.exe"',
      "kimi",
    );
    assert.equal(launch.executable, binary);
    assert.equal(
      launch.environment.PATH?.split(";").filter(
        (p) => p.toLowerCase() === `${home}\\Tools`.toLowerCase(),
      ).length,
      1,
    );
    assert.equal(launch.environment.PATH?.includes("relative"), false);
  });

  it("supports tilde, HOME, and a missing Home directory service", async () => {
    env.HOME = home;
    noHomeService = true;
    const binary = file(`${home}/tools/kimi`);
    assert.equal(
      await resolveRuntimeExecutable("~/tools/kimi", "kimi"),
      binary,
    );
    assert.equal(
      await resolveRuntimeExecutable("${HOME}/tools/kimi", "kimi"),
      binary,
    );
  });

  it("ignores malformed optional install roots without losing healthy defaults", async () => {
    env.NVM_DIR = "relative/nvm";
    env.ASDF_DATA_DIR = "relative/asdf";
    env.PREFIX = "relative/npm";
    env.MISE_DATA_DIR = "relative/mise";
    env.FNM_DIR = "relative/fnm";
    env.PNPM_HOME = "relative/pnpm";
    const binary = file(`${home}/.kimi-code/bin/kimi`);
    assert.equal(await resolveRuntimeExecutable("", "kimi"), binary);
  });

  it("ignores broken links, inaccessible candidates, directories and non-executable files", async () => {
    env.PATH = "/bad-link:/denied:/directory:/no-execute";
    symlink("/bad-link/kimi", "/missing/kimi");
    inaccessible.add(key("/denied/kimi"));
    file("/directory/kimi", "", { type: "directory" });
    file("/no-execute/kimi", "binary", { permissions: 0o644 });
    const binary = file(`${home}/.kimi-code/bin/kimi`);
    assert.equal(await resolveRuntimeExecutable("", "kimi"), binary);
    await assert.rejects(
      resolveRuntimeExecutable("/no-execute/kimi", "kimi"),
      /execute permission/,
    );
  });

  it("reports incomplete npm packages without running their JS shim", async () => {
    const script = file("/opt/homebrew/bin/codex", "#!/usr/bin/env node\n");
    await assert.rejects(
      resolveRuntimeExecutable(script, "codex"),
      /platform binary is missing/,
    );
    assert.deepEqual(calls, []);
  });

  it("rejects shell commands, relative paths, and Windows batch launchers", async () => {
    await assert.rejects(
      resolveRuntimeExecutable("./bin/codex", "codex"),
      /absolute executable path/,
    );
    await assert.rejects(
      resolveRuntimeExecutable("/usr/bin/codex --flag", "codex"),
      /was not usable/,
    );
    setPlatform("WINNT");
    const cmd = file(`${home}\\kimi.cmd`, "@echo off");
    await assert.rejects(resolveRuntimeExecutable(cmd, "kimi"), /native .exe/);
    assert.deepEqual(calls, []);
  });

  it("reads only a bounded header of a large native binary", async () => {
    file(`${home}/.kimi-code/bin/kimi`);
    await resolveRuntimeExecutable("", "kimi");
    assert.deepEqual(reads, [512]);
  });
});

describe("Runtime process launch", () => {
  it("passes arguments with spaces unchanged and augments the GUI PATH", async () => {
    const binary = file(`${home}/工具/Kimi CLI`);
    const result = await runRuntimeCommand(binary, "kimi", [
      "--version",
      "a b",
      "$(literal)",
    ]);
    assert.equal(result.executable, binary);
    assert.deepEqual(calls[0].arguments, ["--version", "a b", "$(literal)"]);
    assert.ok(calls[0].environment.PATH.startsWith(`${home}/工具:`));
    assert.equal(calls[0].environmentAppend, true);
    assert.equal(calls[0].command, binary);
  });

  it("uses the same environment for version probes and JSON-RPC sessions", async () => {
    const binary = file(`${home}/.kimi-code/bin/kimi`);
    await runRuntimeCommand(binary, "kimi", ["--version"]);
    const rpc = await RuntimeJsonLineProcess.open(
      binary,
      "kimi",
      ["acp"],
      "/task path",
    );
    assert.deepEqual(calls[0].environment, calls[1].environment);
    assert.equal(calls[1].workdir, "/task path");
    rpc.close();
  });

  it("removes Windows Path aliases instead of passing conflicting variables", async () => {
    setPlatform("WINNT");
    env.Path = "C:\\tools";
    env.pAtH = "C:\\old";
    file(`${home}\\.kimi-code\\bin\\kimi.exe`);
    await runRuntimeCommand("", "kimi", ["--version"]);
    assert.equal(calls[0].environment.Path, null);
    assert.equal(calls[0].environment.pAtH, null);
    assert.ok(calls[0].environment.PATH.includes("C:\\tools"));
  });

  it("bounds the entire probe including pipes held open after process exit", async () => {
    file(`${home}/.kimi-code/bin/kimi`);
    processFactory = () => makeProcess("", "", 0, true);
    await assert.rejects(
      runRuntimeCommand("", "kimi", ["--version"], 10),
      /timed out/,
    );
    assert.equal(killed, 1);
  });

  it("preserves process exit diagnostics", async () => {
    file(`${home}/.kimi-code/bin/kimi`);
    processFactory = () => makeProcess("", "bad CPU type in executable", 126);
    await assert.rejects(
      runRuntimeCommand("", "kimi", ["--version"]),
      /exited \(126\).*bad CPU type/,
    );
  });
});

describe("Runtime readiness probes", () => {
  // Exercise the real version launcher and adapter lifecycle, replacing only
  // the remote protocol responses. No account or model access is needed.
  async function withRpc(
    respond: (method: string) => unknown,
    check: (calls: string[], closed: () => number) => Promise<void>,
  ) {
    const original = RuntimeJsonLineProcess.open;
    const launched: string[] = [];
    let closes = 0;
    RuntimeJsonLineProcess.open = async (executable) => {
      launched.push(executable);
      return {
        async request(method: string) {
          return respond(method);
        },
        notify() {},
        close() {
          closes++;
        },
        onNotification() {},
        onRequest() {},
        onFailure() {},
      } as unknown as RuntimeJsonLineProcess;
    };
    try {
      await check(launched, () => closes);
    } finally {
      RuntimeJsonLineProcess.open = original;
    }
  }

  it("keeps the actual Codex path and version when app-server initialization fails", async () => {
    const binary = file("/Applications/Codex.app/Contents/Resources/codex");
    await withRpc(
      () => {
        throw new Error("Unsupported initialize method");
      },
      async (launched, closed) => {
        const status = await new PluginCodexAdapter().probe();
        assert.equal(status.state, "error");
        assert.equal(status.executable, binary);
        assert.equal(status.version, "1.2.3");
        assert.deepEqual(
          launched,
          [binary],
          "probe must reuse the resolved executable",
        );
        assert.equal(closed(), 1, "failed handshakes must close their process");
      },
    );
  });

  it("distinguishes a signed-out Codex from a missing installation", async () => {
    file("/Applications/Codex.app/Contents/Resources/codex");
    await withRpc(
      (method) =>
        method === "account/read"
          ? { account: null, requiresOpenaiAuth: true }
          : {},
      async (_launched, closed) => {
        assert.equal(
          (await new PluginCodexAdapter().probe()).state,
          "auth_required",
        );
        assert.equal(closed(), 1);
      },
    );
    files.clear();
    assert.equal((await new PluginCodexAdapter().probe()).state, "unavailable");
  });

  it("checks Kimi authentication at session creation and closes the process", async () => {
    const binary = file(`${home}/.kimi-code/bin/kimi`);
    await withRpc(
      (method) => {
        if (method === "initialize") return { protocolVersion: 1 };
        throw new Error("Authentication required: run kimi login");
      },
      async (launched, closed) => {
        const status = await new PluginKimiAdapter().probe();
        assert.equal(status.state, "auth_required");
        assert.equal(status.executable, binary);
        assert.equal(status.version, "1.2.3");
        assert.deepEqual(launched, [binary]);
        assert.equal(closed(), 1);
      },
    );
  });

  it("reports unsupported ACP as a protocol error and releases failed Kimi initialization", async () => {
    file(`${home}/.kimi-code/bin/kimi`);
    await withRpc(
      () => ({ protocolVersion: 0 }),
      async (_launched, closed) => {
        const status = await new PluginKimiAdapter().probe();
        assert.equal(status.state, "error");
        assert.match(status.message ?? "", /ACP v1/);
        assert.equal(closed(), 1);
      },
    );
  });
});
