import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMORY_READ_TOOLS,
  MEMORY_WRITE_TOOLS,
  PAPER_READ_TOOLS,
  PAPER_WRITE_TOOLS,
} from "@confucius/protocol";
import {
  READ_ONLY_TOOL_NAMES,
  TOOL_DEFINITIONS,
  TOOL_META,
  WRITE_TOOL_NAMES,
} from "./catalog.js";

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

test("catalog has no Chrome browser tools", () => {
  assert.equal(
    TOOL_DEFINITIONS.some((tool) => tool.name.startsWith("browser.")),
    false,
  );
  assert.equal(
    Object.keys(TOOL_META).some((name) => name.startsWith("browser.")),
    false,
  );
});

test("annotation tools expose native anchors alongside the compatible draft contract", () => {
  assert.ok(PAPER_READ_TOOLS.includes("inspect_pdf_page"));
  assert.ok(PAPER_WRITE_TOOLS.includes("propose_annotations"));
  assert.equal(READ_ONLY_TOOL_NAMES.has("inspect_pdf_page"), true);
  assert.equal(WRITE_TOOL_NAMES.has("propose_annotations"), true);
  assert.equal(TOOL_META.inspect_pdf_page.concurrency, "serial");
  assert.equal(TOOL_META.inspect_pdf_page.mutatesState, false);
  assert.equal(TOOL_META.propose_annotations.mutatesState, true);

  const proposal = TOOL_DEFINITIONS.find(
    (candidate) => candidate.name === "propose_annotations",
  );
  assert.ok(proposal);
  assert.deepEqual(proposal.inputSchema.required, [
    "libraryID",
    "key",
    "annotations",
  ]);
  const annotationArray = proposal.inputSchema.properties.annotations as {
    items: { properties: Record<string, unknown> };
  };
  assert.ok(annotationArray.items.properties.rect);
  assert.ok(annotationArray.items.properties.color);
  assert.ok(annotationArray.items.properties.anchor);
  const commit = TOOL_DEFINITIONS.find(
    (tool) => tool.name === "commit_annotations",
  )!;
  const entries = commit.inputSchema.properties.annotations as {
    items: { required: string[] };
  };
  assert.ok(!entries.items.required.includes("page"));
  assert.ok(!entries.items.required.includes("type"));
});

test("organizer tools are defined, typed, and correctly classified for reading/writing", () => {
  const readTools = [
    "organizer_get_outline",
    "organizer_list_annotations",
    "organizer_get_annotation_context",
  ];
  const writeTools = [
    "organizer_assign_annotations",
    "organizer_unassign_annotations",
  ];

  for (const name of readTools) {
    assert.ok(
      TOOL_DEFINITIONS.some((t) => t.name === name),
      `Missing tool definition: ${name}`,
    );
    assert.equal(READ_ONLY_TOOL_NAMES.has(name), true);
    assert.equal(WRITE_TOOL_NAMES.has(name), false);
    assert.equal(TOOL_META[name]?.mutatesState, false);
    assert.equal(TOOL_META[name]?.concurrency, "parallel_safe");
  }

  for (const name of writeTools) {
    assert.ok(
      TOOL_DEFINITIONS.some((t) => t.name === name),
      `Missing tool definition: ${name}`,
    );
    assert.equal(WRITE_TOOL_NAMES.has(name), true);
    assert.equal(READ_ONLY_TOOL_NAMES.has(name), false);
    assert.equal(TOOL_META[name]?.mutatesState, true);
    assert.equal(TOOL_META[name]?.concurrency, "serial");
  }

  const assign = TOOL_DEFINITIONS.find(
    (t) => t.name === "organizer_assign_annotations",
  )!;
  assert.ok(assign);
  assert.deepEqual(assign.inputSchema.required, ["collection", "assignments"]);

  const list = TOOL_DEFINITIONS.find(
    (t) => t.name === "organizer_list_annotations",
  )!;
  assert.ok(list);
  assert.deepEqual(list.inputSchema.required, ["collection"]);
});
