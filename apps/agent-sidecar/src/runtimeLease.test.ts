import assert from "node:assert/strict";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "./codexAdapter";
import { KimiAdapter } from "./kimiAdapter";
import type { RuntimeAdapter, RuntimeEventSink } from "./types";

for (const backend of ["codex", "kimi"] as const) {
  it(`${backend} resumes the provider history with a fresh MCP credential`, async () => {
    const fixture = fileURLToPath(
      new URL(
        `./test-fixtures/${backend === "codex" ? "fake-jsonrpc" : "fake-acp"}.mjs`,
        import.meta.url,
      ),
    );
    const adapter: RuntimeAdapter =
      backend === "codex"
        ? new CodexAdapter(fixture)
        : new KimiAdapter(process.execPath, [fixture]);
    let externalSessionId: string | undefined;
    try {
      for (const token of ["old", "next"]) {
        let complete!: (type: string) => void;
        const terminal = new Promise<string>((resolve) => {
          complete = resolve;
        });
        const sink: RuntimeEventSink = {
          emit(type) {
            if (
              ["turn_completed", "turn_failed", "turn_aborted"].includes(type)
            )
              complete(type);
          },
        };
        const handle = await adapter.startTurn(
          {
            taskId: "rotation",
            turnId: "same-host-turn",
            prompt: token === "next" ? "verify-lease:next" : "begin",
            mode: "agent",
            capabilityProfile: "zotero_only",
            cwd: process.cwd(),
            mcp: { url: "http://localhost/mcp", token },
            developerInstructions: "test",
          },
          sink,
          {
            request: async (request) => ({
              id: request.id,
              verdict: "deny",
              scope: "once",
            }),
          },
        );
        assert.equal(await terminal, "turn_completed");
        if (externalSessionId)
          assert.equal(handle.externalSessionId, externalSessionId);
        externalSessionId = handle.externalSessionId;
      }
    } finally {
      await adapter.dispose("rotation");
    }
  });
}
