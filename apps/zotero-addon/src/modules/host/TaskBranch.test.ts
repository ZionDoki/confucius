import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConfuciusEvent } from "@confucius/protocol";
import { createTaskBranchSnapshot } from "./TaskBranch";
import { preparePromptEdit, attachmentReplayText } from "./TaskEdit";

function event(
  type: ConfuciusEvent["type"],
  payload: unknown,
  turnId: string,
  id = `${turnId}-${type}`,
): ConfuciusEvent {
  return {
    id,
    sessionId: "source-task",
    turnId,
    type,
    ts: 1,
    payload,
  } as ConfuciusEvent;
}

describe("task branch snapshots", () => {
  it("copies only history through the chosen response and resets event ownership", () => {
    const events = [
      event("turn_started", { userText: "Question" }, "turn-1"),
      event(
        "approval_required",
        {
          request: {
            id: "approval-1",
            sessionId: "source-task",
            turnId: "turn-1",
            toolName: "get_item",
            args: {},
            riskLevel: "read",
            createdAt: 1,
          },
        },
        "turn-1",
      ),
      event(
        "approval_resolved",
        { resolution: { id: "approval-1", verdict: "allow" } },
        "turn-1",
      ),
      event("text_delta", { text: "Answer" }, "turn-1"),
      event(
        "artifact_upserted",
        { artifact: { id: "artifact-1", revision: 1 } },
        "turn-1",
      ),
      event("turn_completed", { phase: "done" }, "turn-1"),
      event(
        "approval_required",
        {
          request: {
            id: "pending-note",
            sessionId: "source-task",
            turnId: "note-1",
            toolName: "propose_note",
            args: {},
            riskLevel: "write",
            createdAt: 2,
          },
        },
        "note-1",
      ),
      event("turn_started", { userText: "Later" }, "turn-2"),
      event("text_delta", { text: "Later answer" }, "turn-2"),
      event("turn_completed", { phase: "done" }, "turn-2"),
    ];
    let id = 0;
    const snapshot = createTaskBranchSnapshot(
      events,
      "turn-1",
      "branch-task",
      () => `branch-event-${++id}`,
    );

    assert.deepEqual(snapshot.messages, [
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ]);
    assert.deepEqual(snapshot.artifactIds, ["artifact-1"]);
    assert.equal(
      snapshot.events.some((item) => item.turnId === "turn-2"),
      false,
    );
    assert.equal(
      snapshot.events.some(
        (item) =>
          item.type === "approval_required" &&
          item.payload.request.id === "pending-note",
      ),
      false,
    );
    assert.equal(
      snapshot.events.every((item) => item.sessionId === "branch-task"),
      true,
    );
    const approval = snapshot.events.find(
      (item) => item.type === "approval_required",
    );
    assert.equal(
      approval?.type === "approval_required"
        ? approval.payload.request.sessionId
        : "missing",
      "branch-task",
    );
  });

  it("refuses to branch a response that is still running", () => {
    assert.throws(
      () =>
        createTaskBranchSnapshot(
          [
            event("turn_started", { userText: "Question" }, "turn-1"),
            event("text_delta", { text: "Partial" }, "turn-1"),
          ],
          "turn-1",
          "branch-task",
          () => "event",
        ),
      /finish before branching/,
    );
  });
});

describe("confirmed prompt edits", () => {
  it("distinguishes legacy event IDs reused by different turns", () => {
    const events = [
      event("turn_started", { userText: "Repeated" }, "first", "legacy"),
      event("turn_started", { userText: "Repeated" }, "second", "legacy"),
    ];
    assert.equal(
      preparePromptEdit(events, "legacy", "Repeated", "second").events.length,
      1,
    );
    assert.throws(
      () => preparePromptEdit(events, "legacy", "Repeated"),
      /no longer available/,
    );
  });
  it("retains the prefix and rebuilds model messages without commentary or later tool state", () => {
    const events = [
      event("turn_started", { userText: "Keep this" }, "first"),
      event(
        "text_delta",
        { text: "Working", phase: "commentary" },
        "first",
        "commentary",
      ),
      event("text_delta", { text: "Kept answer" }, "first"),
      event("turn_completed", { phase: "done" }, "first"),
      event("turn_started", { userText: "Replace this" }, "second"),
      event("text_delta", { text: "Discard answer" }, "second"),
      event("turn_started", { userText: "Discard follow up" }, "third"),
    ];
    const before = structuredClone(events);
    const edit = preparePromptEdit(
      events,
      "second-turn_started",
      "Replace this",
    );
    assert.deepEqual(edit.events, events.slice(0, 4));
    assert.deepEqual(edit.messages, [
      { role: "user", content: "Keep this" },
      { role: "assistant", content: "Kept answer" },
    ]);
    assert.deepEqual(edit.removedTurnIds, ["second", "third"]);
    assert.deepEqual(events, before);
    assert.deepEqual(
      preparePromptEdit(events, "first-turn_started", "Keep this").messages,
      [],
    );
    assert.throws(
      () => preparePromptEdit(events, "second-turn_started", "Stale text"),
      /changed/,
    );
    assert.throws(
      () => preparePromptEdit(events, "second-text_delta", "Discard answer"),
      /no longer available/,
    );
  });

  it("recovers attachment bodies only from the archived original prompt", () => {
    const body =
      "\n\n<confucius_read_only_attachments>\nOriginal file\n</confucius_read_only_attachments>";
    assert.equal(attachmentReplayText(["Original prompt" + body]), body);
    assert.throws(
      () => attachmentReplayText(["Missing file"]),
      /no longer available/,
    );
  });
});
