import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composerKeyAction,
  mergeTaskReferences,
  taskMentionChoice,
} from "./workspaceComposer";
import { keyedTimeline } from "./workspaceActivity";
import type { ConfuciusEvent } from "@confucius/protocol";

test("Enter respects Chinese composition and Shift+Enter", () => {
  const key = {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
  };
  assert.equal(composerKeyAction(key, true), "ignore");
  assert.equal(
    composerKeyAction({ ...key, isComposing: true }, false),
    "ignore",
  );
  assert.equal(composerKeyAction({ ...key, keyCode: 229 }, false), "ignore");
  assert.equal(composerKeyAction({ ...key, shiftKey: true }, false), "newline");
  assert.equal(composerKeyAction(key, false), "send");
});
test("same-name conversations retain independent, removable stable references", () => {
  const a = taskMentionChoice({
    id: "a",
    title: "中文论文",
    status: "completed",
    updatedAt: 1,
    backend: "native",
  }).taskReference!;
  const b = { ...a, taskId: "b" };
  const refs = mergeTaskReferences(mergeTaskReferences([a], a), b);
  assert.deepEqual(
    refs.map((ref) => ref.taskId),
    ["a", "b"],
  );
  const draft = JSON.parse(JSON.stringify(refs)).filter(
    (ref: typeof a) => ref.taskId !== "a",
  );
  assert.deepEqual(draft, [b]);
});
test("streaming and tool completions keep earlier activity keys stable", () => {
  const events = [
    {
      id: "one",
      sessionId: "task",
      turnId: "t1",
      ts: 1,
      type: "turn_started",
      payload: { userText: "问题" },
    },
    {
      id: "two",
      sessionId: "task",
      turnId: "t1",
      ts: 2,
      type: "text_delta",
      payload: { text: "回答" },
    },
  ] as ConfuciusEvent[];
  const keys = keyedTimeline(events).map((item) => item.key);
  const extended = keyedTimeline([
    ...events,
    {
      id: "three",
      sessionId: "task",
      turnId: "t1",
      ts: 3,
      type: "text_delta",
      payload: { text: "后续内容" },
    },
    {
      id: "four",
      sessionId: "task",
      turnId: "t2",
      ts: 4,
      type: "turn_started",
      payload: { userText: "追问" },
    },
  ]);
  assert.deepEqual(
    extended.slice(0, keys.length).map((item) => item.key),
    keys,
  );
});

test("search cards and child progress stay at their first chronological position across requests", () => {
  const events: ConfuciusEvent[] = [];
  const add = (type: string, payload: unknown, turnId = "t1") =>
    events.push({
      id: String(events.length),
      sessionId: "task",
      turnId,
      ts: events.length,
      type,
      payload,
    } as ConfuciusEvent);
  const summary = {
    id: "task",
    revision: 1,
    candidateRevision: 0,
    pool: 100,
    evaluated: 0,
    candidates: 0,
    pendingFulltext: 0,
    available: 0,
    read: 0,
    awaitingConfirmation: false,
    latestQuery: {
      id: "q1",
      query: "graph networks",
      total: 2500,
      createdAt: 1,
    },
  };
  add("turn_started", { userText: "Find papers" });
  add("tool_requested", {
    callId: "search",
    toolName: "literature_search",
    args: { query: "graph networks" },
  });
  add("literature_updated", { summary, sources: [] });
  add("tool_result", {
    callId: "search",
    result: { toolName: "literature_search", ok: true, data: {} },
  });
  add("text_delta", { text: "Found 100 papers" });
  const child = {
    id: "child1",
    parentTaskId: "task",
    parentRunId: "run",
    intentRevision: 1,
    parentTurnId: "t1",
    title: "Compare methods",
    status: "running",
    createdAt: 2,
    updatedAt: 2,
    attempt: 1,
  };
  add("subagent_updated", { subagent: child });
  const before = keyedTimeline(events);
  add("turn_started", { userText: "Select these two" }, "t2");
  add(
    "literature_updated",
    { summary: { ...summary, revision: 2, candidates: 2 }, sources: [] },
    "t2",
  );
  add(
    "subagent_updated",
    { subagent: { ...child, status: "completed", updatedAt: 3 } },
    "t2",
  );
  add(
    "literature_updated",
    {
      summary: {
        ...summary,
        latestQuery: { ...summary.latestQuery, id: "q2", query: "new search" },
      },
      sources: [],
    },
    "t2",
  );
  const after = keyedTimeline(events);
  assert.deepEqual(
    after.slice(0, before.length).map((e) => e.key),
    before.map((e) => e.key),
  );
  assert.equal(after.filter((e) => e.block.kind === "literature").length, 2);
  const children = after.filter((e) => e.block.kind === "subagent");
  assert.equal(children.length, 1);
  assert.equal(
    children[0].block.kind === "subagent" && children[0].block.subagent.status,
    "completed",
  );
  const tools = after.flatMap((e) =>
    e.block.kind === "tools" ? e.block.calls : [],
  );
  assert.equal(tools.length, 1);
  assert.equal(tools[0].result?.ok, true);
});
