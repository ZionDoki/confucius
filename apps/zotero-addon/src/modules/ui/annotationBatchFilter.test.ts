import assert from "node:assert/strict";
import { test } from "node:test";
import { installBatchVisibility } from "./annotationBatchFilter";

test("batch visibility intersects native filtering on copies and restores both reader views on disposal", () => {
  const annotations = [
    { id: "a" },
    { id: "b" },
    { id: "legacy", _hidden: true },
  ];
  let visible: string[] = [];
  let selected = "a";
  const reader = {
    _annotationManager: { _annotations: annotations },
    _updateState(state: {
      annotations?: Array<{ id: string; _hidden?: boolean }>;
    }) {
      if (state.annotations)
        visible = state.annotations.filter((a) => !a._hidden).map((a) => a.id);
    },
  };
  const original = reader._updateState;
  let realmCopies = 0;
  const handle = installBatchVisibility(
    reader,
    (id) => id === selected,
    (state) => {
      realmCopies++;
      return structuredClone(state);
    },
  );
  assert.deepEqual(visible, ["a"]);
  assert.deepEqual(annotations, [
    { id: "a" },
    { id: "b" },
    { id: "legacy", _hidden: true },
  ]);
  selected = "b";
  handle.refresh();
  assert.deepEqual(visible, ["b"]);
  reader._annotationManager._annotations.push({ id: "b2" });
  reader._updateState({ annotations: reader._annotationManager._annotations });
  selected = "b2";
  handle.refresh();
  assert.deepEqual(visible, ["b2"]);
  handle.dispose();
  assert.equal(reader._updateState, original);
  assert.ok(
    realmCopies >= 4,
    "render and disposal copy arrays to the reader realm",
  );
  assert.deepEqual(visible, ["a", "b", "b2"]);
});

test("reapplying a batch preserves native search results even when the manager stores unfiltered originals", () => {
  const originals = [{ id: "a" }, { id: "b" }];
  let visible: string[] = [];
  const reader = {
    _annotationManager: { _annotations: originals },
    _updateState(state: {
      annotations?: Array<{ id: string; _hidden?: boolean }>;
    }) {
      if (state.annotations)
        visible = state.annotations.filter((x) => !x._hidden).map((x) => x.id);
    },
  };
  const handle = installBatchVisibility(reader, () => true);
  reader._updateState({
    annotations: [{ id: "a", _hidden: true }, { id: "b" }],
  });
  handle.refresh();
  assert.deepEqual(visible, ["b"]);
  handle.dispose();
  assert.deepEqual(visible, ["b"]);
});
