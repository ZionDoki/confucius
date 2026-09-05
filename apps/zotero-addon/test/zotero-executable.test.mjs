import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { resolveZoteroExecutable } from "../src/development/zoteroExecutable.ts";

const VARIABLE = "ZOTERO_PLUGIN_ZOTERO_BIN_PATH";
function fixture(platform, overrides = {}) {
  const path = platform === "win32" ? win32 : posix;
  const home = platform === "win32" ? "C:\\Users\\Tester" : "/home/tester";
  const existing = new Set();
  const directories = new Map();
  const checked = [];
  const key = (value) =>
    platform === "win32"
      ? win32.normalize(value).toLowerCase()
      : posix.normalize(value);
  const options = {
    platform,
    arch: "x64",
    home,
    cwd: platform === "win32" ? "C:\\project" : "/project",
    env: {},
    isExecutable: (file) => {
      checked.push(file);
      return existing.has(key(file));
    },
    children: (root) => directories.get(key(root)) ?? [],
    registryPaths: () => [],
    ...overrides,
  };
  return {
    options,
    home,
    path,
    checked,
    directories,
    add: (file) => {
      existing.add(key(file));
      return file;
    },
    resolve: () => resolveZoteroExecutable(options),
  };
}

test("macOS detects the installed app with no environment configuration", () => {
  const f = fixture("darwin");
  const executable = f.add("/Applications/Zotero.app/Contents/MacOS/zotero");
  assert.deepEqual(f.resolve(), { path: executable, source: "installation" });
});

test("macOS falls back to a user application after missing PATH candidates", () => {
  const f = fixture("darwin", {
    env: { PATH: "/deleted/bin:/opt/homebrew/bin" },
  });
  const executable = f.add(
    `${f.home}/Applications/Zotero.app/Contents/MacOS/zotero`,
  );
  assert.equal(f.resolve().path, executable);
});

for (const platform of ["darwin", "win32", "linux"]) {
  test(`${platform} honors an explicitly configured path with spaces and Chinese`, () => {
    const f = fixture(platform);
    const executable = f.add(
      f.path.join(
        f.home,
        "研究 软件",
        platform === "win32" ? "zotero.exe" : "zotero",
      ),
    );
    f.options.env[VARIABLE] = `"${executable}"`;
    assert.deepEqual(f.resolve(), { path: executable, source: "configured" });
  });
  test(`${platform} skips empty and relative PATH entries and prefers a valid PATH install`, () => {
    const f = fixture(platform);
    const bin = f.path.join(f.home, "bin");
    const executable = f.add(
      f.path.join(bin, platform === "win32" ? "zotero.exe" : "zotero"),
    );
    f.options.env.PATH = ["", ".", "relative", `"${bin}"`].join(
      platform === "win32" ? ";" : ":",
    );
    assert.deepEqual(f.resolve(), { path: executable, source: "PATH" });
    assert.deepEqual(f.checked, [executable]);
  });
  test(`${platform} reports invalid overrides rather than switching installations`, () => {
    const f = fixture(platform);
    f.options.env[VARIABLE] = f.path.join(f.home, "missing");
    f.options.env.PATH = f.home;
    f.add(f.path.join(f.home, platform === "win32" ? "zotero.exe" : "zotero"));
    assert.throws(f.resolve, /Correct this variable.*leave it empty/);
  });
}

test("macOS accepts an app bundle override and expands tilde", () => {
  const f = fixture("darwin", {
    env: { [VARIABLE]: "~/Applications/Zotero.app" },
  });
  const executable = f.add(
    `${f.home}/Applications/Zotero.app/Contents/MacOS/zotero`,
  );
  assert.equal(f.resolve().path, executable);
});

test("Windows finds native Program Files with case-insensitive environment keys", () => {
  const f = fixture("win32", { env: { programfiles: "D:\\Applications" } });
  const executable = f.add("D:\\Applications\\Zotero\\zotero.exe");
  assert.equal(f.resolve().path, executable);
});

test("Windows covers 32-bit and per-user installations", () => {
  for (const executable of [
    "C:\\Program Files (x86)\\Zotero\\zotero.exe",
    "C:\\Users\\Tester\\AppData\\Local\\Zotero\\zotero.exe",
    "C:\\Users\\Tester\\AppData\\Local\\Programs\\Zotero\\zotero.exe",
  ]) {
    const f = fixture("win32");
    f.add(executable);
    assert.equal(f.resolve().path, executable);
  }
});

test("Windows expands profile variables and treats PATH keys case-insensitively", () => {
  const f = fixture("win32", {
    env: { userprofile: "D:\\Users\\研究员", Path: '"%USERPROFILE%\\Tools"' },
  });
  const executable = f.add("D:\\Users\\研究员\\Tools\\zotero.exe");
  assert.equal(f.resolve().path, executable);
});

test("Windows can use an App Paths registration outside standard directories", () => {
  const f = fixture("win32", {
    registryPaths: () => ['"D:\\研究工具\\Zotero\\zotero.exe"'],
  });
  const executable = f.add("D:\\研究工具\\Zotero\\zotero.exe");
  assert.deepEqual(f.resolve(), { path: executable, source: "registry" });
});

test("Windows never launches a batch command as Zotero", () => {
  const f = fixture("win32", { env: { [VARIABLE]: "D:\\zotero.cmd" } });
  f.add("D:\\zotero.cmd");
  assert.throws(f.resolve, /not an executable Zotero file/);
});

test("Linux finds system, tarball and user installs", () => {
  for (const executable of [
    "/usr/bin/zotero",
    "/opt/zotero/zotero",
    "/usr/lib/zotero/zotero",
    "/home/tester/.local/bin/zotero",
    "/home/tester/.local/opt/zotero/zotero",
  ]) {
    const f = fixture("linux");
    f.add(executable);
    assert.equal(f.resolve().path, executable);
  }
});

test("Linux discovers official extracted archives for the host architecture", () => {
  for (const [arch, directory] of [
    ["x64", "Zotero_linux-x86_64"],
    ["arm64", "Zotero_linux-aarch64"],
  ]) {
    const f = fixture("linux", { arch });
    f.directories.set("/opt", [
      "Zotero_linux-x86_64",
      "Zotero_linux-aarch64",
      "other-app",
      "../Zotero-evil",
    ]);
    f.add("/opt/Zotero_linux-x86_64/zotero");
    f.add("/opt/Zotero_linux-aarch64/zotero");
    assert.equal(f.resolve().path, `/opt/${directory}/zotero`);
  }
});

test("Unix returns the launcher spelling without breaking argv[0] dispatch", () => {
  const f = fixture("linux", { env: { PATH: "/snap/bin" } });
  f.add("/snap/bin/zotero");
  assert.equal(f.resolve().path, "/snap/bin/zotero");
});

test("optional filesystem and registry failures still produce an actionable error", () => {
  const f = fixture("win32", {
    isExecutable: () => {
      throw new Error("access denied");
    },
    registryPaths: () => {
      throw new Error("registry denied");
    },
  });
  assert.throws(
    f.resolve,
    /Install Zotero 7.*ZOTERO_PLUGIN_ZOTERO_BIN_PATH.*Checked:/,
  );
});

test("real filesystem discovery rejects a directory and a non-executable Unix file", () => {
  const root = mkdtempSync(join(tmpdir(), "confucius-executable-"));
  try {
    assert.throws(
      () => resolveZoteroExecutable({ env: { [VARIABLE]: root } }),
      /not an executable/,
    );
    if (process.platform !== "win32") {
      const file = join(root, "zotero");
      writeFileSync(file, "#!/bin/sh\n", { mode: 0o600 });
      assert.throws(
        () => resolveZoteroExecutable({ env: { [VARIABLE]: file } }),
        /not an executable/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const scaffoldUrl = import.meta.resolve("zotero-plugin-scaffold");
const configPath = fileURLToPath(
  new URL("../zotero-plugin.config.ts", import.meta.url),
);
function withConfigFixture(check) {
  const root = mkdtempSync(join(tmpdir(), "confucius-start-config-"));
  const executable = join(
    root,
    process.platform === "win32" ? "Zotero.exe" : "zotero",
  );
  writeFileSync(executable, "test executable, never launched", { mode: 0o755 });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "confucius-config-test",
      version: "0.3.6",
      type: "module",
      repository: { url: "git+https://github.com/ZionDoki/confucius.git" },
      config: { prefsPrefix: "confucius.test" },
    }),
  );
  writeFileSync(
    join(root, "zotero-plugin.config.ts"),
    `export { default } from ${JSON.stringify(configPath)};`,
  );
  const run = (mode, extraEnv = {}) => {
    const env = { ...process.env };
    delete env[VARIABLE];
    return execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `process.argv = [process.execPath, 'config-check', ${JSON.stringify(mode)}]; const { Config, Serve } = await import(${JSON.stringify(scaffoldUrl)}); const context = await Config.loadConfig(); console.log(${mode === "serve" ? "new Serve(context).zoteroBinPath" : "'BUILD_CONFIG_OK'"});`,
      ],
      {
        cwd: root,
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
  };
  try {
    check({ root, executable, run });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("real scaffold loads .env before resolving the development binary", () => {
  withConfigFixture(({ root, executable, run }) => {
    writeFileSync(
      join(root, ".env"),
      `${VARIABLE}=${JSON.stringify(executable)}\n`,
    );
    assert.ok(run("serve").includes(executable));
  });
});

test("an explicit shell environment takes precedence over .env", () => {
  withConfigFixture(({ root, executable, run }) => {
    writeFileSync(join(root, ".env"), `${VARIABLE}=/missing/example/zotero\n`);
    assert.ok(run("serve", { [VARIABLE]: executable }).includes(executable));
  });
});

test("real scaffold resolves an unconfigured PATH installation before its early binary check", () => {
  withConfigFixture(({ root, executable, run }) => {
    assert.ok(run("serve", { PATH: root }).includes(executable));
  });
});

test("CI build configuration loads even with an invalid Zotero override", () => {
  withConfigFixture(({ run }) => {
    assert.ok(
      run("build", { [VARIABLE]: "/does-not-exist/zotero" }).includes(
        "BUILD_CONFIG_OK",
      ),
    );
  });
});
