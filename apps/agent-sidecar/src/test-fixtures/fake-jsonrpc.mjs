import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.153.0\n");
  process.exit(0);
}

function send(value, fragmented = false) {
  const line = `${JSON.stringify(value)}\n`;
  if (!fragmented) {
    process.stdout.write(line);
    return;
  }
  const middle = Math.max(1, Math.floor(line.length / 2));
  process.stdout.write(line.slice(0, middle));
  setTimeout(() => process.stdout.write(line.slice(middle)), 5);
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (message.method === "ping") {
    process.stdout.write("not json\n");
    send({ id: message.id, result: { pong: true } }, true);
    continue;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
    continue;
  }
  if (message.method === "account/read") {
    send({
      id: message.id,
      result: {
        account: { type: "apiKey" },
        requiresOpenaiAuth: true,
      },
    });
    continue;
  }
  if (message.method === "config/read") {
    send({
      id: message.id,
      result: {
        config: {
          mcp_servers: {
            personal_server: { enabled: true },
          },
        },
        origins: {},
        layers: null,
      },
    });
    continue;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({
      id: message.id,
      result: { thread: { id: message.params?.threadId || "thread_fake" } },
    });
    continue;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_fake" } } });
    const prompt = message.params?.input?.[0]?.text || "";
    if (prompt.includes("crash")) {
      setTimeout(() => process.exit(7), 10);
      continue;
    }
    if (prompt.includes("approval")) {
      send({
        id: 91,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: message.params.threadId,
          turnId: "turn_fake",
          command: "echo denied",
        },
      });
      continue;
    }
    send(
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: message.params.threadId,
          turnId: "turn_fake",
          delta: "hello",
        },
      },
      true,
    );
    setTimeout(
      () =>
        send({
          method: "turn/completed",
          params: {
            threadId: message.params.threadId,
            turn: { id: "turn_fake", status: "completed" },
          },
        }),
      15,
    );
    continue;
  }
  if (message.id === 91 && !message.method) {
    send({
      method: "turn/completed",
      params: {
        threadId: "thread_fake",
        turn: { id: "turn_fake", status: "completed" },
      },
    });
    continue;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turn: { id: message.params.turnId, status: "interrupted" },
      },
    });
  }
}
