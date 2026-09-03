import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { ApprovalResolution, ConfuciusEvent } from "@confucius/protocol";
import {
  CodexAdapter,
  codexAppServerArgs,
  codexRuntimeConfig,
} from "./codexAdapter";

const fixture = fileURLToPath(
  new URL("./test-fixtures/fake-jsonrpc.mjs", import.meta.url),
);

function harness() {
  const events: ConfuciusEvent[] = [];
  return {
    events,
    sink: {
      emit(type: ConfuciusEvent["type"], payload: unknown, turnId?: string) {
        events.push({
          id: `e${events.length}`,
          sessionId: "task_a",
          turnId,
          type,
          ts: Date.now(),
          payload,
        } as ConfuciusEvent);
      },
    },
    approvals: {
      request: async (request: {
        id: string;
      }): Promise<ApprovalResolution> => ({
        id: request.id,
        verdict: "allow",
        scope: "once",
      }),
    },
  };
}

function input(prompt: string, externalSessionId?: string) {
  return {
    taskId: "task_a",
    turnId: "turn_a",
    prompt,
    mode: "agent" as const,
    capabilityProfile: "zotero_only" as const,
    cwd: process.cwd(),
    externalSessionId,
    mcp: { url: "http://127.0.0.1:1/mcp", token: "token" },
    developerInstructions: "test",
  };
}

async function waitFor(
  predicate: () => boolean,
  timeout = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("event timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Codex App Server contract", () => {
  it("removes shell and unrelated integrations in Zotero-only mode", () => {
    const args = codexAppServerArgs("codex.js", "zotero_only");
    assert.deepEqual(args.slice(0, 2), ["codex.js", "app-server"]);
    for (const feature of [
      "shell_tool",
      "unified_exec",
      "multi_agent",
      "apps",
    ]) {
      const index = args.findIndex(
        (value, position) =>
          value === feature && args[position - 1] === "--disable",
      );
      assert.notEqual(
        index,
        -1,
        `${feature} must be disabled at process start`,
      );
    }

    const config = codexRuntimeConfig(
      "zotero_only",
      ["personal_server", "confucius"],
      { url: "http://127.0.0.1:3210/mcp", token: "temporary" },
    ) as Record<string, unknown>;
    const features = config.features as Record<string, unknown>;
    assert.equal(features.shell_tool, false);
    assert.equal(features.unified_exec, false);
    assert.equal(config.web_search, "disabled");
    const servers = config.mcp_servers as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(servers.personal_server, { enabled: false });
    assert.equal(servers.confucius?.required, true);
    assert.equal(
      (servers.confucius?.http_headers as Record<string, unknown>)
        .Authorization,
      "Bearer temporary",
    );

    const workspaceArgs = codexAppServerArgs("codex.js", "workspace");
    assert.equal(workspaceArgs.includes("browser_use"), true);
    assert.equal(workspaceArgs.includes("shell_tool"), false);
    const workspaceConfig = codexRuntimeConfig(
      "workspace",
      ["personal_server"],
      { url: "http://127.0.0.1:3210/mcp", token: "temporary" },
    ) as Record<string, unknown>;
    assert.equal(workspaceConfig.web_search, "disabled");
    assert.equal(
      (workspaceConfig.features as Record<string, unknown>).apps,
      false,
    );
    assert.deepEqual(
      (workspaceConfig.mcp_servers as Record<string, unknown>)
        .personal_server,
      { enabled: false },
    );
  });

  it("probes 0.153.0 and maps fragmented streaming completion", async () => {
    const adapter = new CodexAdapter(fixture);
    const status = await adapter.probe();
    assert.equal(status.version, "0.153.0");
    assert.equal(status.state, "ready");
    const test = harness();
    const handle = await adapter.startTurn(
      input("hello"),
      test.sink,
      test.approvals,
    );
    assert.equal(handle.externalSessionId, "thread_fake");
    await waitFor(() =>
      test.events.some((event) => event.type === "turn_completed"),
    );
    assert.equal(
      test.events
        .filter((event) => event.type === "text_delta")
        .map((event) => (event.type === "text_delta" ? event.payload.text : ""))
        .join(""),
      "hello",
    );
    assert.equal(
      test.events.every((event) => event.turnId === "turn_a"),
      true,
      "provider turn ids must be mapped back to the Confucius host turn",
    );
    await adapter.dispose("task_a");
  });

  it("resumes an external thread id and denies command approval in Zotero-only mode", async () => {
    const adapter = new CodexAdapter(fixture);
    const test = harness();
    const handle = await adapter.startTurn(
      input("approval", "thread_saved"),
      test.sink,
      test.approvals,
    );
    assert.equal(handle.externalSessionId, "thread_saved");
    await waitFor(() =>
      test.events.some((event) => event.type === "approval_resolved"),
    );
    const resolved = test.events.find(
      (event) => event.type === "approval_resolved",
    );
    assert.equal(
      resolved?.type === "approval_resolved"
        ? resolved.payload.resolution.verdict
        : "missing",
      "deny",
    );
    await adapter.dispose("task_a");
  });

  it("turns a runtime crash into a terminal error event", async () => {
    const adapter = new CodexAdapter(fixture);
    const test = harness();
    await adapter.startTurn(input("crash"), test.sink, test.approvals);
    await waitFor(() =>
      test.events.some((event) => event.type === "turn_failed"),
    );
    assert.ok(
      test.events.some((event) => event.type === "task_status_changed"),
    );
  });
});
