import assert from "node:assert/strict";
import { test } from "node:test";
import {
  responseLanguageContext,
  responseLanguageInstruction,
} from "./ResponseLanguage";

test("bare skills and repeated continuations retain real language evidence after restart", () => {
  const original = responseLanguageContext([
    "Bitte kommentiere die wichtigsten Aussagen auf Deutsch.",
  ]);
  let restored = JSON.parse(JSON.stringify(original));
  for (const command of [
    "/annotation-pass",
    "继续",
    "Continue",
    "/paper-deep-reading",
    "/annotation-pass",
    "resume",
  ])
    restored = responseLanguageContext([command], restored);
  assert.deepEqual(restored, original);
  const instruction = responseLanguageInstruction({
    userText: restored.request,
    fallbackLanguage: "en-US",
  });
  assert.match(instruction, /auf Deutsch/);
  assert.match(instruction, /only when neither the request nor conversation/);
  assert.doesNotMatch(instruction, /Use English for/);
});

test("language evidence follows new requests, preserves explicit choices and excludes skill slugs", () => {
  let context = responseLanguageContext(["请用中文解释。"]);
  context = responseLanguageContext(
    [" /annotation-pass Please write the comments in German."],
    context,
  );
  assert.equal(context.request, "Please write the comments in German.");
  assert.deepEqual(context.priorRequests, ["请用中文解释。"]);
  const instruction = responseLanguageInstruction({
    userText: context.request,
    conversationRequests: context.priorRequests,
    fallbackLanguage: "zh-CN",
  });
  assert.match(instruction, /explicit output-language request first/);
  assert.match(instruction, /comments in German/);
  assert.match(
    instruction,
    /Source papers, quoted passages, tool descriptions/,
  );
  assert.match(
    instruction,
    /never translate a quote used to locate an annotation/,
  );
  assert.doesNotMatch(instruction, /\/annotation-pass/);
});

test("requests in languages beyond the UI locales remain language evidence", () => {
  for (const text of [
    "Résume cet article en français.",
    "日本語で要点を説明してください。",
    "اشرح النتائج بالعربية.",
  ])
    assert.equal(responseLanguageContext([text]).request, text);
  const empty = responseLanguageContext(["/annotation-pass", "continue"]);
  assert.deepEqual(empty, { request: "", priorRequests: [] });
  assert.match(
    responseLanguageInstruction({ userText: "", fallbackLanguage: "zh-CN" }),
    /Simplified Chinese \(zh-CN\)/,
  );
});

test("language context bounds retained requests and tolerates missing legacy fields", () => {
  const context = responseLanguageContext(
    ["A".repeat(10_000) + "请用中文回答"],
    { request: "old", priorRequests: [] },
  );
  assert.ok(context.request.length < 2100);
  assert.ok(context.request.endsWith("请用中文回答"));
  const recent = responseLanguageContext([
    "one",
    "two",
    "three",
    "four",
    "five",
  ]);
  assert.deepEqual(recent.priorRequests, ["two", "three", "four"]);
  assert.equal(recent.request, "five");
});
