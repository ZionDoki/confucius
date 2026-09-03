import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("kimi 1.2.3\n");
  process.exit(0);
}

const lines = createInterface({ input: process.stdin });
let pendingPrompt = null;
let pendingPermission = null;
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.argv.includes("--auth-required")) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "login required" },
      });
      continue;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, close: {} },
        },
        agentInfo: { name: "fake-kimi", version: "1.2.3" },
      },
    });
    continue;
  }
  if (message.method === "session/new") {
    if (process.argv.includes("--auth-on-session-new")) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "Authentication required" },
      });
      continue;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "kimi_fake" },
    });
    continue;
  }
  if (
    message.method === "session/load" ||
    message.method === "session/resume"
  ) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    continue;
  }
  if (message.method === "session/set_mode") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        modes: {
          currentModeId: message.params.modeId,
          availableModes: [],
        },
      },
    });
    continue;
  }
  if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    const prompt = JSON.stringify(message.params.prompt || []);
    if (prompt.includes("crash-runtime")) {
      setTimeout(() => process.exit(7), 5);
      continue;
    }
    if (prompt.includes("wait-for-cancel")) {
      pendingPrompt = { id: message.id, sessionId };
      continue;
    }
    if (prompt.includes("confucius-permission")) {
      pendingPermission = { promptId: message.id, sessionId };
      send({
        jsonrpc: "2.0",
        id: 201,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: {
            toolCallId: "mcp_read",
            kind: "other",
            name: "mcp__confucius__search_items",
            title: "Search Zotero",
            rawInput: { query: "evidence" },
          },
          options: [
            {
              optionId: "approve_once",
              name: "Approve once",
              kind: "allow_once",
            },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      continue;
    }
    if (prompt.includes("forbidden-command")) {
      pendingPrompt = { id: message.id, sessionId };
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "cmd_forbidden",
            kind: "execute",
            name: "Bash",
            title: "Run command",
            rawInput: { command: "echo forbidden" },
          },
        },
      });
      continue;
    }
    if (prompt.includes("workspace-events")) {
      for (const update of [
        {
          sessionUpdate: "tool_call",
          toolCallId: "cmd_workspace",
          kind: "execute",
          name: "Bash",
          title: "Run command",
          rawInput: { command: "npm test" },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "cmd_workspace",
          status: "completed",
          rawOutput: "ok",
        },
        {
          sessionUpdate: "tool_call",
          toolCallId: "edit_workspace",
          kind: "edit",
          name: "Edit",
          title: "Edit report.md",
          locations: [{ path: "report.md", line: 1 }],
          rawInput: { path: "report.md", diff: "+result" },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit_workspace",
          status: "completed",
        },
      ]) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update },
        });
      }
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "answer" },
        },
      },
    });
    setTimeout(
      () =>
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: "end_turn" },
        }),
      10,
    );
    continue;
  }
  if (message.id === 201 && !message.method && pendingPermission) {
    const selected = message.result?.outcome?.optionId === "approve_once";
    const { promptId, sessionId } = pendingPermission;
    pendingPermission = null;
    if (selected) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "approved" },
          },
        },
      });
    }
    send({
      jsonrpc: "2.0",
      id: promptId,
      result: { stopReason: selected ? "end_turn" : "refusal" },
    });
    continue;
  }
  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    continue;
  }
  if (message.method === "session/cancel") {
    if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
    if (pendingPrompt) {
      send({
        jsonrpc: "2.0",
        id: pendingPrompt.id,
        result: { stopReason: "cancelled" },
      });
      pendingPrompt = null;
    }
  }
}
