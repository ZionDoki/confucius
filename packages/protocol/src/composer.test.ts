import assert from "node:assert/strict";
import { test } from "node:test";
import { composerMentions, composerMentionText } from "./composer";

test("draft references retain distinct identities even with equal titles", () => {
  const text = "@[Same] compare @[Same]";
  const mentions = [
    { id: "item:1:A", label: "Same", start: 0, end: 7 },
    { id: "task:ses_b", label: "Same", start: 16, end: 23 },
  ];
  mentions[1].start = text.lastIndexOf("@[");
  mentions[1].end = text.length;
  assert.deepEqual(composerMentions(text, mentions), mentions);
});

test("malformed and stale draft ranges cannot claim unrelated prose", () => {
  const text = "@[Paper] text";
  const valid = { id: "item:1:A", label: "Paper", start: 0, end: 8 };
  assert.deepEqual(composerMentions(text, [valid, valid]), [valid]);
  for (const row of [
    { ...valid, start: -1 },
    { ...valid, end: 12 },
    { ...valid, label: "Different" },
    { ...valid, id: "<html>" },
    { ...valid, end: Infinity },
    { ...valid, start: 0.5 },
  ])
    assert.deepEqual(composerMentions(text, [row]), []);
  assert.deepEqual(composerMentions(text, undefined), []);
  assert.equal(composerMentionText("A [paper]\n"), "@[A paper]");
});
