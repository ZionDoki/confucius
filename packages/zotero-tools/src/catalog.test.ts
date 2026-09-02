import assert from "node:assert/strict";
import test from "node:test";
import { MEMORY_READ_TOOLS, MEMORY_WRITE_TOOLS } from "@confucius/protocol";
import { TOOL_DEFINITIONS, TOOL_META } from "./catalog.js";

test("attach_file advertises local paths and HTTP(S) URLs", () => {
  const definition = TOOL_DEFINITIONS.find(
    (candidate) => candidate.name === "attach_file",
  );
  assert.ok(definition);
  assert.deepEqual(definition.inputSchema.required, ["libraryID", "key"]);
  assert.deepEqual(definition.inputSchema.properties.path, {
    type: "string",
    description: "Absolute path to a local file",
  });
  assert.deepEqual(definition.inputSchema.properties.url, {
    type: "string",
    description: "HTTP(S) URL to download and attach",
  });
  assert.match(definition.description, /exactly one of path or url/i);
});

test("knowledge-base tools are typed, approval-gated, and use mind-map kinds", () => {
  assert.ok(MEMORY_READ_TOOLS.includes("knowledge_base_list"));
  assert.ok(MEMORY_READ_TOOLS.includes("knowledge_base_get"));
  assert.ok(MEMORY_READ_TOOLS.includes("knowledge_base_search"));
  assert.deepEqual(MEMORY_READ_TOOLS.slice(-2), [
    "conversation_log_search",
    "conversation_log_read",
  ]);
  assert.deepEqual(MEMORY_WRITE_TOOLS.slice(-3), [
    "knowledge_base_create",
    "knowledge_base_update",
    "knowledge_base_save_entry",
  ]);
  const saveEntry = TOOL_DEFINITIONS.find(
    (candidate) => candidate.name === "knowledge_base_save_entry",
  );
  assert.ok(saveEntry);
  const kindSchema = saveEntry.inputSchema.properties.kind as {
    enum: string[];
  };
  assert.deepEqual(kindSchema.enum, [
    "paper",
    "note",
    "insight",
    "method",
    "discussion",
    "mindmap",
  ]);
  assert.equal(TOOL_META.knowledge_base_search.concurrency, "parallel_safe");
  assert.equal(TOOL_META.knowledge_base_save_entry.mutatesState, true);
});
