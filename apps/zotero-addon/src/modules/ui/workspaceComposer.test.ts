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
