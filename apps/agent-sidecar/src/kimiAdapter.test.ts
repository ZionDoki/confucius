import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { ApprovalResolution, ConfuciusEvent } from "@confucius/protocol";
import { KimiAdapter } from "./kimiAdapter";

const fixture = fileURLToPath(
  new URL("./test-fixtures/fake-acp.mjs", import.meta.url),
);

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("event timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Kimi ACP v1 contract", () => {
  it("negotiates ACP, streams updates, and completes", async () => {
    const adapter = new KimiAdapter(process.execPath, [fixture]);
    const status = await adapter.probe();
    assert.equal(status.state, "ready");
    assert.equal(status.version, "1.2.3");
    const events: ConfuciusEvent[] = [];
    const handle = await adapter.startTurn(
      {
        taskId: "task_kimi",
        turnId: "turn_kimi",
        prompt: "test",
        mode: "agent",
        capabilityProfile: "zotero_only",
        cwd: process.cwd(),
        mcp: { url: "http://127.0.0.1:1/mcp", token: "token" },
        developerInstructions: "test",
      },
      {
        emit(type, payload, turnId) {
          events.push({
            id: `e${events.length}`,
            sessionId: "task_kimi",
            turnId,
            type,
            ts: Date.now(),
            payload,
          } as ConfuciusEvent);
        },
      },
      {
        request: async (request): Promise<ApprovalResolution> => ({
          id: request.id,
          verdict: "deny",
          scope: "once",
        }),
      },
    );
    assert.equal(handle.externalSessionId, "kimi_fake");
    await waitFor(() =>
      events.some((event) => event.type === "turn_completed"),
    );
    assert.ok(events.some((event) => event.type === "reasoning_delta"));
    assert.equal(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => (event.type === "text_delta" ? event.payload.text : ""))
        .join(""),
      "answer",
    );
    await adapter.dispose("task_kimi");
  });

  it("uses ACP session recovery and maps cancellation", async () => {
    const adapter = new KimiAdapter(process.execPath, [fixture]);
    const events: ConfuciusEvent[] = [];
    const handle = await adapter.startTurn(
      {
        taskId: "task_kimi_resume",
        turnId: "turn_kimi_resume",
        prompt: "wait-for-cancel",
        mode: "agent",
        capabilityProfile: "zotero_only",
        cwd: process.cwd(),
        externalSessionId: "kimi_saved",
        mcp: { url: "http://127.0.0.1:1/mcp", token: "token" },
        developerInstructions: "test",
      },
      {
        emit(type, payload, turnId) {
          events.push({
            id: `e${events.length}`,
            sessionId: "task_kimi_resume",
            turnId,
            type,
            ts: Date.now(),
            payload,
          } as ConfuciusEvent);
        },
      },
      {
        request: async (request): Promise<ApprovalResolution> => ({
          id: request.id,
          verdict: "deny",
          scope: "once",
        }),
      },
    );
    assert.equal(handle.externalSessionId, "kimi_saved");
    await adapter.interrupt("task_kimi_resume");
    await waitFor(() => events.some((event) => event.type === "turn_aborted"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "task_status_changed" &&
          event.payload.status === "interrupted",
      ),
    );
    await adapter.dispose("task_kimi_resume");
  });

  it("reports missing login and runtime crashes", async () => {
    const authAdapter = new KimiAdapter(process.execPath, [
      fixture,
      "--auth-required",
    ]);
    const status = await authAdapter.probe();
    assert.equal(status.state, "auth_required");

    const sessionAuthAdapter = new KimiAdapter(process.execPath, [
      fixture,
      "--auth-on-session-new",
    ]);
    const sessionStatus = await sessionAuthAdapter.probe();
    assert.equal(sessionStatus.state, "auth_required");
    assert.equal(sessionStatus.version, "1.2.3");

    const crashAdapter = new KimiAdapter(process.execPath, [fixture]);
    const events: ConfuciusEvent[] = [];
    await crashAdapter.startTurn(
      {
        taskId: "task_kimi_crash",
        turnId: "turn_kimi_crash",
        prompt: "crash-runtime",
        mode: "agent",
        capabilityProfile: "zotero_only",
        cwd: process.cwd(),
        mcp: { url: "http://127.0.0.1:1/mcp", token: "token" },
        developerInstructions: "test",
      },
      {
        emit(type, payload, turnId) {
          events.push({
            id: `e${events.length}`,
            sessionId: "task_kimi_crash",
            turnId,
            type,
            ts: Date.now(),
            payload,
          } as ConfuciusEvent);
        },
      },
      {
        request: async (request): Promise<ApprovalResolution> => ({
          id: request.id,
          verdict: "deny",
          scope: "once",
        }),
      },
    );
    await waitFor(() => events.some((event) => event.type === "turn_failed"));
  });

  it("allows only the task-scoped Confucius MCP through ACP permission", async () => {
    const adapter = new KimiAdapter(process.execPath, [fixture]);
    const events: ConfuciusEvent[] = [];
    await adapter.startTurn(
      {
        taskId: "task_kimi_mcp",
        turnId: "turn_kimi_mcp",
        prompt: "confucius-permission",
        mode: "agent",
        capabilityProfile: "zotero_only",
        cwd: process.cwd(),
        mcp: { url: "http://127.0.0.1:1/mcp", token: "token" },
        developerInstructions: "test",
      },
      {
        emit(type, payload, turnId) {
          events.push({
            id: `e${events.length}`,
            sessionId: "task_kimi_mcp",
            turnId,
            type,
            ts: Date.now(),
            payload,
          } as ConfuciusEvent);
        },
      },
      {
        request: async () => {
          throw new Error("Confucius MCP must be gated by the Zotero host");
        },
      },
    );
    await waitFor(() =>
      events.some((event) => event.type === "turn_completed"),
    );
    assert.equal(
      events.some((event) => event.type === "approval_required"),
      false,
    );
    await adapter.dispose("task_kimi_mcp");
  });

  it("fails closed if a Zotero-only provider emits a command anyway", async () => {
    const adapter = new KimiAdapter(process.execPath, [fixture]);
    const events: ConfuciusEvent[] = [];
    await adapter.startTurn(
      {
        taskId: "task_kimi_forbidden",
        turnId: "turn_kimi_forbidden",
        prompt: "forbidden-command",
        mode: "agent",
        capabilityProfile: "zotero_only",
        cwd: process.cwd(),
        mcp: { url: "http://127.0.0.1:1/mcp", token: "token" },
        developerInstructions: "test",
      },
      {
        emit(type, payload, turnId) {
          events.push({
            id: `e${events.length}`,
            sessionId: "task_kimi_forbidden",
            turnId,
            type,
            ts: Date.now(),
            payload,
          } as ConfuciusEvent);
        },
      },
      {
        request: async (request): Promise<ApprovalResolution> => ({
          id: request.id,
          verdict: "allow",
          scope: "once",
        }),
      },
    );
    await waitFor(() => events.some((event) => event.type === "turn_failed"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "task_status_changed" &&
          event.payload.status === "failed",
      ),
    );
    assert.equal(
      events.some((event) => event.type === "command_execution"),
      false,
    );
    await adapter.dispose("task_kimi_forbidden");
  });

  it("maps command and file lifecycle events for an approved workspace", async () => {
    const adapter = new KimiAdapter(process.execPath, [fixture]);
    const events: ConfuciusEvent[] = [];
    await adapter.startTurn(
      {
        taskId: "task_kimi_workspace",
        turnId: "turn_kimi_workspace",
        prompt: "workspace-events",
        mode: "agent",
        capabilityProfile: "workspace",
        cwd: process.cwd(),
        mcp: { url: "http://127.0.0.1:1/mcp", token: "token" },
        developerInstructions: "test",
      },
      {
        emit(type, payload, turnId) {
          events.push({
            id: `e${events.length}`,
            sessionId: "task_kimi_workspace",
            turnId,
            type,
            ts: Date.now(),
            payload,
          } as ConfuciusEvent);
        },
      },
      {
        request: async (request): Promise<ApprovalResolution> => ({
          id: request.id,
          verdict: "allow",
          scope: "once",
        }),
      },
    );
    await waitFor(() =>
      events.some((event) => event.type === "turn_completed"),
    );
    assert.ok(events.some((event) => event.type === "command_execution"));
    assert.ok(events.some((event) => event.type === "file_change"));
    await adapter.dispose("task_kimi_workspace");
  });
});
