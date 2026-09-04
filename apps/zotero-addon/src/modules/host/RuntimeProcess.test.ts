import assert from "node:assert/strict";
import { win32 } from "node:path";
import { beforeEach, describe, it } from "node:test";

const globals = globalThis as unknown as Record<string, unknown>;
const existing = new Set<string>();
const children = new Map<string, string[]>();
const modified = new Map<string, number>();
const pathResults = new Map<string, string>();
const normalize = (value: string) => win32.normalize(value).toLowerCase();

globals.Services = {
  appinfo: { OS: "WINNT", XPCOMABI: "x86_64-gcc3" },
  env: {
    get(name: string) {
      if (name === "PATH") return "";
      if (name === "LOCALAPPDATA") return "C:\\Users\\Test\\AppData\\Local";
      if (name === "APPDATA") return "C:\\Users\\Test\\AppData\\Roaming";
      return "";
    },
  },
  dirsvc: {
    get() {
      return { path: "C:\\Users\\Test" };
    },
  },
};
globals.PathUtils = {
  isAbsolute: win32.isAbsolute,
  normalize: win32.normalize,
  join: win32.join,
  parent: win32.dirname,
};
globals.IOUtils = {
  async exists(value: string) {
    return existing.has(normalize(value));
  },
  async getChildren(value: string) {
    return children.get(normalize(value)) ?? [];
  },
  async stat(value: string) {
    return {
      type: "directory",
      lastModified: modified.get(normalize(value)) ?? 0,
      size: 100_000,
    };
  },
  async readUTF8() {
    return "";
  },
};
globals.Ci = { nsIFile: {} };
globals.ChromeUtils = {
  importESModule() {
    return {
      Subprocess: {
        async pathSearch(command: string) {
          const result = pathResults.get(command.toLowerCase());
          if (!result) throw new Error("not found");
          return result;
        },
      },
    };
  },
};

const { resolveRuntimeExecutable } = await import("./RuntimeProcess");

describe("Runtime executable discovery", () => {
  beforeEach(() => {
    existing.clear();
    children.clear();
    modified.clear();
    pathResults.clear();
  });

  it("finds the official Kimi install even when Zotero inherited no PATH", async () => {
    const executable = "C:\\Users\\Test\\.kimi-code\\bin\\kimi.exe";
    existing.add(normalize(executable));
    assert.equal(await resolveRuntimeExecutable("", "kimi"), executable);
  });

  it("prefers the newest versioned Codex Desktop binary", async () => {
    const root = "C:\\Users\\Test\\AppData\\Local\\OpenAI\\Codex\\bin";
    const oldDirectory = win32.join(root, "old");
    const newDirectory = win32.join(root, "new");
    const oldExecutable = win32.join(oldDirectory, "codex.exe");
    const newExecutable = win32.join(newDirectory, "codex.exe");
    existing.add(normalize(root));
    existing.add(normalize(oldExecutable));
    existing.add(normalize(newExecutable));
    children.set(normalize(root), [oldDirectory, newDirectory]);
    modified.set(normalize(oldDirectory), 10);
    modified.set(normalize(newDirectory), 20);

    assert.equal(await resolveRuntimeExecutable("", "codex"), newExecutable);
  });

  it("honors a manually configured executable before auto-detection", async () => {
    const manual = "D:\\Agents\\kimi.exe";
    existing.add(normalize(manual));
    assert.equal(await resolveRuntimeExecutable(manual, "kimi"), manual);
  });
});
