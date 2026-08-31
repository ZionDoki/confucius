import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { ApprovalResolution } from "@confucius/protocol";
import type { ModelTurn } from "./ModelAdapter";
import { createHarness, session } from "./test-kit";

const evalsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "evals",
);

interface EvalCase {
  id: string;
  userText: string;
  maxIterations?: number;
  approval?: "allow" | "deny";
  modelScript: ModelTurn[];
  expectedEventTypes?: string[];
  expectedToolRequests?: number;
  expectedLastEvent?: string;
}

function loadCases(): EvalCase[] {
  return readdirSync(evalsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) =>
      JSON.parse(readFileSync(join(evalsDir, name), "utf8")) as EvalCase,
    );
}

describe("evals/* golden traces", () => {
  const cases = loadCases();
  assert.ok(cases.length >= 3, "eval traces missing");

  for (const testCase of cases) {
    it(`${testCase.id}: replays the golden event sequence`, async () => {
      const resolve = testCase.approval
        ? (request: { id: string }): ApprovalResolution => ({
            id: request.id,
            verdict: testCase.approval === "allow" ? "allow" : "deny",
            scope: "once",
          })
        : undefined;
      const harness = createHarness({
        script: testCase.modelScript,
        maxIterations: testCase.maxIterations ?? 8,
        resolve,
      });
      const result = await harness.loop.run({
        session: session("eval"),
        turnId: "t_eval",
        userText: testCase.userText,
      });
      const types = harness.events.types();

      if (testCase.expectedEventTypes) {
        assert.deepEqual(types, testCase.expectedEventTypes);
      }
      const toolRequests = types.filter(
        (type) => type === "tool_requested",
      ).length;
      if (testCase.expectedToolRequests !== undefined) {
        assert.equal(toolRequests, testCase.expectedToolRequests);
      }
      if (testCase.expectedLastEvent) {
        assert.equal(types[types.length - 1], testCase.expectedLastEvent);
      }
      assert.ok(result.messages.length > 0);
    });
  }
});
