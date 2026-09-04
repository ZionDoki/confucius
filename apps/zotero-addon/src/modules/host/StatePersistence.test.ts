import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stringifyDurableHostState } from "./StatePersistence";

describe("host state persistence", () => {
  it("defensively removes transient PDF media from every persisted branch", () => {
    const serialized = stringifyDurableHostState({
      tasks: [
        {
          messages: [
            {
              role: "user",
              content: "page",
              transient: true,
              images: [{ data: "IMAGE-SENTINEL" }],
            },
          ],
          latestCheckpoint: {
            transientMedia: [{ data: "CHECKPOINT-SENTINEL" }],
          },
        },
      ],
    });

    assert.doesNotMatch(
      serialized,
      /IMAGE-SENTINEL|CHECKPOINT-SENTINEL|transientMedia|"images"|"transient"/,
    );
  });
});
