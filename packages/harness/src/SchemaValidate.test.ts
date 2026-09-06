import assert from "node:assert/strict";
import { it } from "node:test";
import { validateArgs } from "./SchemaValidate";
import type { JsonSchemaObject } from "@confucius/protocol";
const schema: JsonSchemaObject = {
  type: "object",
  properties: {
    libraryID: { type: "integer", minimum: 1 },
    key: { type: "string", minLength: 1 },
    values: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        properties: { x: { type: "number", minimum: 0, maximum: 1000 } },
        required: ["x"],
        additionalProperties: false,
      },
    },
    union: {
      oneOf: [
        {
          type: "object",
          properties: { type: { const: "n" }, value: { type: "integer" } },
          required: ["type", "value"],
        },
        {
          type: "object",
          properties: { type: { const: "s" }, value: { type: "string" } },
          required: ["type", "value"],
        },
      ],
    },
  },
  required: ["key"],
  additionalProperties: false,
};
it("normalizes numeric strings recursively and explicit item aliases", () => {
  const args = {
    itemKey: "ITEM",
    libraryID: "2",
    values: [{ x: "0.25" }],
    union: { type: "n", value: "7" },
  };
  assert.equal(validateArgs("write", schema, args), null);
  assert.deepEqual(args, {
    key: "ITEM",
    libraryID: 2,
    values: [{ x: 0.25 }],
    union: { type: "n", value: 7 },
  });
});
it("reports nested array paths, range errors, conflicting aliases and explicit undefined required values", () => {
  const invalid = validateArgs("write", schema, {
    key: "ITEM",
    itemKey: "OTHER",
    values: [{ x: 2000 }, { x: "wrong" }, {}],
    libraryID: "Infinity",
  });
  assert.equal(invalid?.code, "invalid_args");
  for (const path of [
    "$.key",
    "$.values[0].x",
    "$.values[1].x",
    "$.values[2].x",
    "$.libraryID",
  ])
    assert.ok(
      invalid?.issues?.some((issue) => issue.path === path),
      path,
    );
  assert.ok(validateArgs("write", schema, { key: undefined }));
  assert.ok(validateArgs("write", schema, [] as never));
});
it("delegates only annotation entry errors to partial batch preflight", () => {
  const batch: JsonSchemaObject = {
    type: "object",
    properties: {
      annotations: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "object", required: ["type"] },
      },
    },
    required: ["annotations"],
  };
  assert.equal(
    validateArgs("commit_annotations", batch, {
      annotations: [{ type: "highlight" }, 42],
    }),
    null,
  );
  assert.ok(
    validateArgs("commit_annotations", batch, { annotations: "wrong" }),
  );
  assert.ok(validateArgs("other", batch, { annotations: [42] }));
});
