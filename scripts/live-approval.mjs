/**
 * Live interactive-approval verification against the running Zotero add-on.
 *
 * A deterministic local model requests memory writes. The test proves that
 * approval_required is observable while the turn is still waiting, then
 * checks both deny and allow before removing the temporary memory.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILE_PREFS = resolve(
  ROOT,
  "apps/zotero-addon/.scaffold/profile/prefs.js",
);
const MOCK_PORT = Number(process.env.CONFUCIUS_APPROVAL_MOCK_PORT || 18766);
const MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`;
const CALL_MARKER = "CONFUCIUS_APPROVAL_CALL ";
let extractionCalls = 0;

function parseUserPrefs(source) {
  const prefs = new Map();
  const pattern = /user_pref\("([^"]+)",\s*(.+?)\);/g;
  for (const match of source.matchAll(pattern)) {
    try {
      prefs.set(match[1], JSON.parse(match[2]));
    } catch {
      // Ignore unrelated preference syntax.
    }
  }
  return prefs;
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function startModelServer() {
  let callSequence = 0;
  extractionCalls = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", MOCK_ORIGIN);
      if (url.pathname === "/v1/models") {
        json(response, 200, {
          object: "list",
          data: [{ id: "confucius-approval-e2e", object: "model" }],
        });
        return;
      }
      if (url.pathname !== "/v1/chat/completions") {
        json(response, 404, { error: "not found" });
        return;
      }

      const body = await requestBody(request);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (
        messages[0]?.role === "system" &&
        String(messages[0].content || "").includes(
          "You maintain the long-term memory of Confucius",
        )
      ) {
        extractionCalls += 1;
        json(response, 200, {
          id: `chatcmpl-extraction-${extractionCalls}`,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "[]" },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
        });
        return;
      }
      let userIndex = -1;
      let specification = null;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== "user" || typeof message.content !== "string") {
          continue;
        }
        const markerIndex = message.content.indexOf(CALL_MARKER);
        if (markerIndex < 0) continue;
        userIndex = index;
        specification = JSON.parse(
          message.content.slice(markerIndex + CALL_MARKER.length),
        );
        break;
      }
      const hasToolResult =
        userIndex >= 0 &&
        messages
          .slice(userIndex + 1)
          .some((message) => message?.role === "tool");
      const message =
        specification && !hasToolResult
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_approval_${++callSequence}`,
                  type: "function",
                  function: {
                    name: String(specification.name),
                    arguments: JSON.stringify(specification.args || {}),
                  },
                },
              ],
            }
          : { role: "assistant", content: "Approval test completed." };
      json(response, 200, {
        id: `chatcmpl-approval-${callSequence}`,
        object: "chat.completion",
        choices: [{ index: 0, finish_reason: "stop", message }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      });
    } catch (error) {
      json(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(MOCK_PORT, "127.0.0.1", resolveListen);
  });
  return server;
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function main() {
  const prefs = parseUserPrefs(await readFile(PROFILE_PREFS, "utf8"));
  const pairingToken = String(
    prefs.get("extensions.zotero.confucius.pairingToken") || "",
  );
  const zoteroPort = Number(
    process.env.CONFUCIUS_ZOTERO_PORT ||
      prefs.get("extensions.zotero.httpServer.port") ||
      23119,
  );
  assert.ok(pairingToken, "Development pairing token not found");

  const rpcUrl = `http://127.0.0.1:${zoteroPort}/confucius/v1/rpc`;
  let rpcId = 0;
  const rpc = async (method, params = {}) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pairingToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method,
        params,
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message || `RPC HTTP ${response.status}`);
    }
    return payload.result;
  };

  let server;
  let sessionId = "";
  let temporaryEndpointId = "";
  let temporaryMemoryId = "";
  let originalConfig;

  const eventsFor = async (turnId) => {
    const bundle = await rpc("session/events", { sessionId });
    return (bundle.events || []).filter((event) => event.turnId === turnId);
  };

  const waitFor = async (turnId, predicate, label, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const events = await eventsFor(turnId);
      const match = predicate(events);
      if (match) return { events, match };
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${label}`);
      }
      await delay(50);
    }
  };

  const startCall = async (name, args) => {
    const started = await rpc("session/prompt", {
      sessionId,
      text: `${CALL_MARKER}${JSON.stringify({ name, args })}`,
    });
    return started.turnId;
  };

  const waitForApproval = async (turnId, expectedTool) => {
    const { events, match: request } = await waitFor(
      turnId,
      (items) =>
        items.find((event) => event.type === "approval_required")?.payload
          .request,
      `approval_required for ${expectedTool}`,
    );
    assert.equal(request.toolName, expectedTool);
    assert.equal(
      events.some((event) => event.type === "tool_result"),
      false,
      "write tool ran before approval",
    );
    return request;
  };

  const resolveAndWait = async (turnId, request, verdict) => {
    await rpc("approval/resolve", {
      id: request.id,
      verdict,
      scope: "once",
    });
    const { events } = await waitFor(
      turnId,
      (items) =>
        items.find((event) =>
          ["turn_completed", "turn_failed", "turn_aborted"].includes(
            event.type,
          ),
        ),
      `turn completion after ${verdict}`,
    );
    const result = events.find((event) => event.type === "tool_result")?.payload
      .result;
    assert.ok(result, "tool_result was not emitted");
    return { events, result };
  };

  try {
    server = await startModelServer();
    originalConfig = await rpc("config/get");
    const configured = await rpc("config/set", {
      endpoint: {
        name: "Confucius approval E2E",
        baseUrl: `${MOCK_ORIGIN}/v1`,
        apiKey: "local-e2e-only",
        model: "confucius-approval-e2e",
        maxTokens: 0,
        reasoningEffort: "off",
        contextWindowTokens: 16_384,
      },
      streamResponses: false,
      memoryAutoExtract: true,
      maxIterations: 4,
      maxToolCalls: 4,
    });
    temporaryEndpointId = configured.activeEndpointId;

    const session = await rpc("session/new", {
      title: `Approval E2E ${Date.now()}`,
      mode: "agent",
    });
    sessionId = session.id;
    await rpc("session/setPermissions", {
      sessionId,
      permissionMode: "ask",
    });

    const marker = `approval-e2e-${Date.now()}`;
    const deniedTurn = await startCall("memory_save", {
      type: "fact",
      title: marker,
      content: "This temporary memory must be denied.",
      tags: ["approval-e2e"],
    });
    const deniedRequest = await waitForApproval(deniedTurn, "memory_save");
    const denied = await resolveAndWait(deniedTurn, deniedRequest, "deny");
    assert.equal(denied.result.ok, false);
    assert.equal(denied.result.code, "permission_denied");
    await delay(250);
    assert.equal(
      extractionCalls,
      0,
      "ask mode must not run background memory extraction",
    );

    const allowedTurn = await startCall("memory_save", {
      type: "fact",
      title: marker,
      content: "This temporary memory is removed by the same test.",
      tags: ["approval-e2e"],
    });
    const allowedRequest = await waitForApproval(allowedTurn, "memory_save");
    const allowed = await resolveAndWait(allowedTurn, allowedRequest, "allow");
    assert.equal(allowed.result.ok, true);
    temporaryMemoryId = String(allowed.result.data?.id || "");
    assert.ok(temporaryMemoryId, "allowed write returned no memory id");

    const deleteTurn = await startCall("memory_delete", {
      id: temporaryMemoryId,
    });
    const deleteRequest = await waitForApproval(deleteTurn, "memory_delete");
    const removed = await resolveAndWait(deleteTurn, deleteRequest, "allow");
    assert.equal(removed.result.ok, true);
    temporaryMemoryId = "";

    console.log("Live approval flow passed: pending, deny, allow, cleanup.");
  } finally {
    if (temporaryMemoryId) {
      await rpc("memory/delete", { id: temporaryMemoryId }).catch(
        () => undefined,
      );
    }
    if (sessionId) {
      await rpc("session/delete", { sessionId }).catch(() => undefined);
    }
    if (originalConfig && temporaryEndpointId) {
      await rpc("config/set", {
        activeEndpointId: originalConfig.activeEndpointId,
        streamResponses: originalConfig.streamResponses,
        memoryAutoExtract: originalConfig.memoryAutoExtract,
        maxIterations: originalConfig.maxIterations,
        maxToolCalls: originalConfig.maxToolCalls,
      }).catch(() => undefined);
      await rpc("config/set", {
        deleteEndpointId: temporaryEndpointId,
      }).catch(() => undefined);
    }
    await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
