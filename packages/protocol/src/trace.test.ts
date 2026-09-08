import assert from "node:assert/strict";
import { it } from "node:test";
import { analyzeTaskTrace, type TaskTraceReport } from "./trace";
import type { ConfuciusEvent } from "./events";

function fixture() {
  const report: TaskTraceReport = {
    kind: "confucius-task-trace",
    schemaVersion: 1,
    task: { id: "s", title: "Review", backend: "codex", status: "interrupted" },
    capture: {
      startedAt: 1,
      finishedAt: 100,
      running: false,
      changedDuringExport: false,
    },
    coverage: [],
    issues: [],
    redactions: { credentials: 0, binaryPayloads: 0 },
    sections: {
      state: {
        capturedAt: 1,
        data: {
          record: {
            run: {
              id: "run",
              intentRevision: 2,
              sources: { fingerprint: "pdf" },
              requiredArtifactKinds: ["deep_read"],
              status: "interrupted",
              modelRequest: { requestId: "executor", status: "started" },
            },
          },
        },
      },
    },
    events: [],
  };
  const add = (
    type: string,
    payload: unknown,
    origin: "host" | "executor" = "executor",
  ) =>
    report.events.push({
      id: String(report.events.length),
      ts: report.events.length + 1,
      sessionId: "s",
      turnId: "t",
      type,
      payload,
      origin,
    } as ConfuciusEvent);
  return { report, add };
}

it("groups model streams without duplicated host text and keeps retries out of reasoning", () => {
  const { report, add } = fixture();
  add("text_delta", { itemId: "opening", text: "I will " });
  add("text_delta", { itemId: "opening", text: "read." });
  add("text_delta", { itemId: "opening", text: "", phase: "commentary" });
  add("text_delta", { text: "I will read.", phase: "commentary" }, "host");
  add("reasoning_delta", { text: "", statusText: "Reconnecting... 1/5" });
  add("reasoning_delta", { itemId: "r", text: "Public ", source: "summary" });
  add("reasoning_delta", { itemId: "r", text: "summary.", source: "summary" });
  add("model_request_progress", {
    scope: "provider",
    requestId: "provider",
    parentRequestId: "executor",
    attempt: 1,
    maxAttempts: 5,
    status: "failed",
    retryable: true,
    code: "responseStreamDisconnected",
  });
  add("text_delta", { itemId: "answer", text: "Done.", phase: "final_answer" });
  add("text_delta", { text: "Done.", phase: "final_answer" }, "host");
  const result = analyzeTaskTrace(report);
  assert.deepEqual(
    result.output.map(({ phase, text }) => ({ phase, text })),
    [
      { phase: "commentary", text: "I will read." },
      { phase: "final_answer", text: "Done." },
    ],
  );
  assert.deepEqual(
    result.reasoning.map(({ text }) => text),
    ["Public summary."],
  );
  assert.ok(
    result.incidents.some(({ message }) =>
      message.includes("responseStreamDisconnected"),
    ),
  );
  assert.ok(
    result.incidents.some(({ message }) => message.includes("仍标为 started")),
  );
  assert.deepEqual(report.issues, []);
});

it("identifies saved writes, missing current artifacts and repeated evidence independently of export errors", () => {
  const { report, add } = fixture();
  report.sections.artifacts = {
    capturedAt: 1,
    data: [
      {
        record: {
          kind: "deep_read",
          status: "ready",
          execution: {
            runId: "run",
            intentRevision: 1,
            sourceFingerprint: "pdf",
          },
        },
      },
    ],
  };
  add("tool_result", {
    callId: "save",
    result: {
      ok: true,
      toolName: "commit_annotations",
      data: {
        committed: Array.from({ length: 8 }, (_, i) => ({
          annotationKey: `key${i}`,
        })),
      },
    },
  });
  for (let i = 0; i < 3; i++) {
    add("tool_requested", {
      callId: `read${i}`,
      toolName: "get_pages",
      args: { rereadReason: i ? "Verify denominator" : undefined },
    });
    add("tool_result", {
      callId: `read${i}`,
      result: {
        ok: true,
        toolName: "get_pages",
        data: {
          attachmentKey: "pdf",
          pages: [
            { page: 4, text: i === 2 ? "" : "Evidence", omitted: i === 2 },
          ],
        },
      },
    });
  }
  const result = analyzeTaskTrace(report);
  assert.equal(result.work.savedAnnotations, 8);
  assert.deepEqual(result.work.missing, ["deep_read"]);
  assert.deepEqual(result.repeatedPages, [
    {
      page: 4,
      attachmentKey: "pdf",
      count: 2,
      reasons: ["Verify denominator"],
    },
  ]);
  assert.match(result.reasoningCoverage, /不能据此判断模型没有思考/);
  assert.ok(
    result.incidents.some(({ message }) => message.includes("最终回复")),
  );
});

it("keeps a diagnostic report readable when an archived event has a missing body", () => {
  const { report, add } = fixture();
  add("text_delta", undefined);
  add("tool_result", {});
  add("text_delta", { text: "Retained answer", phase: "final_answer" });
  const result = analyzeTaskTrace(report);
  assert.equal(result.output[0].text, "Retained answer");
  assert.equal(
    result.incidents.filter(({ message }) => message.includes("正文缺失"))
      .length,
    2,
  );
});
