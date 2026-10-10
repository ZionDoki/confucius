import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalBroker } from "./approvalBroker.js";

test("invalid approval replies preserve the pending request for a valid decision", async () => {
  const broker = new ApprovalBroker();
  let settled = false;
  const pending = broker
    .request({
      id: "approval",
      sessionId: "task",
      turnId: "turn",
      toolName: "runtime.command",
      args: {},
      riskLevel: "command",
      createdAt: 1,
    })
    .then((resolution) => {
      settled = true;
      return resolution;
    });
  for (const invalid of [
    null,
    { id: "approval", scope: "once" },
    { id: "approval", verdict: "reject", scope: "once" },
    { id: "approval", verdict: "allow", scope: "invalid" },
    { id: "approval", verdict: "allow", scope: "once", editedArgs: [] },
    { id: "other", verdict: "allow", scope: "once" },
  ]) {
    assert.equal(broker.resolve(invalid), false);
    await Promise.resolve();
    assert.equal(settled, false);
  }
  assert.equal(
    broker.resolve({ id: "approval", verdict: "deny", scope: "once" }),
    true,
  );
  assert.equal((await pending).verdict, "deny");
});
