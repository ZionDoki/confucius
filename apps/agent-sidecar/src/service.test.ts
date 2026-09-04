import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SidecarService } from "./service.js";
import type { RuntimeAdapter, RuntimeTurnInput } from "./types.js";

test("runtime configuration persists only the Kimi executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "confucius-sidecar-config-"));
  const path = join(root, "sidecar-config.json");
  try {
    const service = new SidecarService(path);
    const result = await service.rpc("runtime/configure", {
      backend: "kimi",
      executable: "C:\\Tools\\kimi.exe",
    });
    assert.deepEqual(result, {
      ok: true,
      executable: "C:\\Tools\\kimi.exe",
    });
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved, { kimiExecutable: "C:\\Tools\\kimi.exe" });
    assert.equal(JSON.stringify(saved).includes("token"), false);

    const restored = new SidecarService(path);
    await restored.initialize();
    const configured = await restored.rpc("runtime/configure", {
      backend: "kimi",
      executable: "",
    });
    assert.deepEqual(configured, { ok: true, executable: "kimi" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime/list re-probes login state instead of serving a stale cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "confucius-sidecar-probe-"));
  let ready = false;
  let probes = 0;
  const fake: RuntimeAdapter = {
    kind: "kimi",
    async probe() {
      probes += 1;
      return {
        backend: "kimi",
        state: ready ? "ready" : "auth_required",
        checkedAt: Date.now(),
      };
    },
    async startTurn() {
      return { externalSessionId: "unused" };
    },
    async interrupt() {},
    async dispose() {},
  };
  try {
    const service = new SidecarService(
      join(root, "config.json"),
      join(root, "workspaces"),
    );
    const internals = service as unknown as {
      adapters: Map<string, RuntimeAdapter>;
    };
    internals.adapters.clear();
    internals.adapters.set("kimi", fake);
    const first = (await service.rpc("runtime/list", {})) as {
      runtimes: Array<{ state: string }>;
    };
    ready = true;
    const second = (await service.rpc("runtime/list", {})) as {
      runtimes: Array<{ state: string }>;
    };
    assert.equal(first.runtimes[0]?.state, "auth_required");
    assert.equal(second.runtimes[0]?.state, "ready");
    assert.equal(probes, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime analysis ignores caller cwd and uses an isolated directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "confucius-sidecar-analysis-"));
  let analyzedCwd = "";
  const fake: RuntimeAdapter = {
    kind: "codex",
    async probe() {
      return { backend: "codex", state: "ready", checkedAt: Date.now() };
    },
    async startTurn() {
      return { externalSessionId: "unused" };
    },
    async interrupt() {},
    async dispose() {},
    async analyze(_prompt, cwd) {
      analyzedCwd = cwd;
      return "analysis";
    },
  };
  try {
    const service = new SidecarService(
      join(root, "config.json"),
      join(root, "workspaces"),
    );
    const internals = service as unknown as {
      adapters: Map<string, RuntimeAdapter>;
    };
    internals.adapters.set("codex", fake);
    const result = await service.rpc("runtime/analyze", {
      backend: "codex",
      prompt: "summarize",
      cwd: join(root, "must-not-be-used"),
    });
    assert.deepEqual(result, { text: "analysis" });
    assert.equal(
      analyzedCwd,
      await realpath(join(root, "workspaces", "analysis_codex")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace turns require an absolute real path and shutdown releases them", async () => {
  const root = await mkdtemp(join(tmpdir(), "confucius-sidecar-workspace-"));
  const selected = join(root, "selected");
  await mkdir(selected);
  const inputs: RuntimeTurnInput[] = [];
  const disposed: string[] = [];
  const fake: RuntimeAdapter = {
    kind: "codex",
    async probe() {
      return { backend: "codex", state: "ready", checkedAt: Date.now() };
    },
    async startTurn(input) {
      inputs.push(input);
      return { externalSessionId: "external_1" };
    },
    async interrupt() {},
    async dispose(taskId) {
      disposed.push(taskId);
    },
  };
  try {
    const service = new SidecarService(
      join(root, "config.json"),
      join(root, "isolated"),
    );
    const internals = service as unknown as {
      adapters: Map<string, RuntimeAdapter>;
    };
    internals.adapters.set("codex", fake);
    service.host.register("http://127.0.0.1:23119/confucius/v1", "pairing");
    service.setMcpUrl("http://127.0.0.1:23120/mcp");

    await assert.rejects(
      service.rpc("task/startTurn", {
        backend: "codex",
        taskId: "task_relative",
        turnId: "turn_1",
        prompt: "x",
        capabilityProfile: "workspace",
        workingDirectory: ".\\relative",
      }),
      /absolute/,
    );
    await service.rpc("task/startTurn", {
      backend: "codex",
      taskId: "task_workspace",
      turnId: "turn_2",
      prompt: "x",
      capabilityProfile: "workspace",
      workingDirectory: selected,
      includeArtifactGuidance: false,
      workflowInstruction: "RESEARCH PHASE ONLY",
    });
    assert.equal(inputs[0]?.cwd, await realpath(selected));
    assert.match(
      inputs[0]?.developerInstructions ?? "",
      /RESEARCH PHASE ONLY/,
    );
    assert.doesNotMatch(
      inputs[0]?.developerInstructions ?? "",
      /artifact_upsert/,
    );
    await service.shutdown();
    assert.deepEqual(disposed, ["task_workspace"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
