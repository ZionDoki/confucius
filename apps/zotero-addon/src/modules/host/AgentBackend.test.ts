import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConfuciusEvent, ResearchTaskRecord } from "@confucius/protocol";
import { ExternalBackend, type BackendCallbacks } from "./AgentBackend";
import type { SidecarClient, SidecarEventPage } from "./SidecarClient";

function task(): ResearchTaskRecord {
  return {
    id: "task-1",
    title: "Contract test",
    titleState: "fixed",
    createdAt: 1,
    updatedAt: 1,
    mode: "agent",
    permissionMode: "ask",
    context: {},
    schemaVersion: 2,
    backend: "codex",
    status: "ready",
    capabilityProfile: "zotero_only",
    lockedContext: {
      version: 1,
      capturedAt: 1,
      fingerprint: "locked",
      items: [],
    },
    artifactIds: [],
  };
}

function failedEvent(id = "event-failed", turnId = "turn-1"): ConfuciusEvent {
  return {
    id,
    sessionId: "task-1",
    turnId,
    type: "turn_failed",
    ts: 2,
    payload: { message: "Authentication required" },
  };
}

function failedStatusEvent(): ConfuciusEvent {
  return {
    id: "event-status",
    sessionId: "task-1",
    turnId: "turn-1",
    type: "task_status_changed",
    ts: 2,
    payload: { status: "failed" },
  };
}

function callbacks(seen: ConfuciusEvent[]) {
  let handles = 0;
  let disconnects = 0;
  const value: BackendCallbacks = {
    event: (event) => seen.push(event),
    handle: () => {
      handles += 1;
    },
    disconnected: () => {
      disconnects += 1;
    },
  };
  return {
    value,
    handles: () => handles,
    disconnects: () => disconnects,
  };
}

describe("ExternalBackend", () => {
  it("owns runtime probing and quiet analysis behind the backend boundary", async () => {
    const sidecar = {
      listRuntimes: async () => ({
        sidecarConnected: true,
        runtimes: [
          {
            backend: "codex",
            state: "ready",
            version: "0.153.0",
            checkedAt: 1,
          },
        ],
      }),
      rpc: async (method: string) => {
        assert.equal(method, "runtime/analyze");
        return { text: "quiet result" };
      },
    } as unknown as SidecarClient;
    const backend = new ExternalBackend("codex", sidecar);

    assert.equal((await backend.probe()).version, "0.153.0");
    assert.equal(await backend.analyze("extract memory"), "quiet result");
  });

  it("forwards buffered startup failures before rejecting the start RPC", async () => {
    let eventReads = 0;
    const sidecar = {
      events: async (): Promise<SidecarEventPage> => {
        eventReads += 1;
        return eventReads === 1
          ? { events: [], cursorFound: true }
          : { events: [failedEvent()], cursorFound: true };
      },
      rpc: async () => {
        throw new Error("Codex sign-in required");
      },
    } as unknown as SidecarClient;
    const backend = new ExternalBackend("codex", sidecar);
    const seen: ConfuciusEvent[] = [];
    const observed = callbacks(seen);

    await assert.rejects(
      backend.startTurn(
        {
          task: task(),
          turnId: "turn-1",
          prompt: "Audit the evidence",
          mode: "agent",
          capabilityProfile: "zotero_only",
        },
        observed.value,
      ),
      /sign-in required/,
    );

    assert.deepEqual(
      seen.map((event) => event.type),
      ["turn_failed"],
    );
    assert.equal(observed.handles(), 0);
    assert.equal(observed.disconnects(), 0);
  });

  it("delivers status before one terminal and ignores duplicate terminals", async () => {
    let eventReads = 0;
    let terminalSeen!: () => void;
    const terminal = new Promise<void>((resolve) => {
      terminalSeen = resolve;
    });
    let startParams: Record<string, unknown> | undefined;
    const sidecar = {
      events: async (): Promise<SidecarEventPage> => {
        eventReads += 1;
        if (eventReads === 1) return { events: [], cursorFound: true };
        return {
          events: [
            failedStatusEvent(),
            failedEvent("terminal-1"),
            failedEvent("terminal-2"),
          ],
          cursorFound: true,
        };
      },
      rpc: async (_method: string, params: Record<string, unknown>) => {
        startParams = params;
        return { externalSessionId: "provider-session" };
      },
    } as unknown as SidecarClient;
    const backend = new ExternalBackend("codex", sidecar);
    const seen: ConfuciusEvent[] = [];
    const observed = callbacks(seen);
    const wrapped: BackendCallbacks = {
      ...observed.value,
      event: (event) => {
        seen.push(event);
        if (event.type === "turn_failed") terminalSeen();
      },
    };

    await backend.startTurn(
      {
        task: task(),
        turnId: "turn-1",
        prompt: "Audit the evidence",
        mode: "agent",
        capabilityProfile: "zotero_only",
        includeArtifactGuidance: false,
        workflowInstruction: "RESEARCH PHASE ONLY",
      },
      wrapped,
    );
    await terminal;
    await Promise.resolve();

    assert.deepEqual(
      seen.map((event) => event.id),
      ["event-status", "terminal-1"],
    );
    assert.equal(observed.handles(), 1);
    assert.equal(observed.disconnects(), 0);
    assert.equal(eventReads, 2);
    assert.equal(startParams?.includeArtifactGuidance, false);
    assert.equal(startParams?.workflowInstruction, "RESEARCH PHASE ONLY");
  });

  it("keeps polling when a terminal from the superseded turn arrives late", async () => {
    let eventReads = 0;
    let currentTerminalSeen!: () => void;
    const currentTerminal = new Promise<void>((resolve) => {
      currentTerminalSeen = resolve;
    });
    const sidecar = {
      events: async (): Promise<SidecarEventPage> => {
        eventReads += 1;
        if (eventReads === 1) return { events: [], cursorFound: true };
        if (eventReads === 2) {
          return {
            events: [failedEvent("stale-terminal", "turn-old")],
            cursorFound: true,
          };
        }
        return {
          events: [failedEvent("current-terminal", "turn-1")],
          cursorFound: true,
        };
      },
      rpc: async () => ({ externalSessionId: "provider-session" }),
    } as unknown as SidecarClient;
    const backend = new ExternalBackend("codex", sidecar);
    const seen: ConfuciusEvent[] = [];

    await backend.startTurn(
      {
        task: task(),
        turnId: "turn-1",
        prompt: "Continue",
        mode: "agent",
        capabilityProfile: "zotero_only",
      },
      {
        ...callbacks(seen).value,
        event: (event) => {
          seen.push(event);
          if (event.id === "current-terminal") currentTerminalSeen();
        },
      },
    );
    await currentTerminal;
    await Promise.resolve();

    assert.deepEqual(
      seen.map((event) => event.id),
      ["stale-terminal", "current-terminal"],
    );
    assert.equal(eventReads, 3);
  });
});
