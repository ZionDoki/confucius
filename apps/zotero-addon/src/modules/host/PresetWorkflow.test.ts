import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emptyLockedContext,
  type ResearchTaskRecord,
} from "@confucius/protocol";
import { setTaskPreset } from "./TaskPreset";
import {
  presetWorkflow,
  presetToolNames,
  presetToolCallInScope,
  PresetToolProvider,
  isContinueRequest,
} from "./PresetWorkflow";
import { MemoryToolProvider, type ToolProvider } from "@confucius/harness";
describe("task preset selection", () => {
  function task(backend: ResearchTaskRecord["backend"] = "native") {
    const record: ResearchTaskRecord = {
      id: "preset-task",
      title: "Research draft",
      titleState: "fixed",
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 4,
      backend,
      mode: "agent",
      status: "ready",
      context: {},
      lockedContext: emptyLockedContext(1),
      capabilityProfile: "zotero_only",
      permissionMode: "ask",
      artifactIds: ["existing-report"],
      draft: {
        text: "只检查方法部分，保留我修改的内容。",
        references: [{ kind: "task", taskId: "evidence-task", title: "证据" }],
      },
    };
    return {
      record,
      loadedSkills: new Set(["custom-skill"]),
      activeTurnId: null as string | null,
    };
  }

  for (const backend of ["native", "codex", "kimi"] as const) {
    it(`${backend} persists preset cancellation without changing the draft, sources, or results`, async () => {
      const state = task(backend);
      const original = structuredClone(state.record);
      let saved = "";
      const persist = async () => {
        saved = JSON.stringify({
          record: state.record,
          loadedSkills: [...state.loadedSkills],
        });
      };
      await setTaskPreset(state, "deep-read", persist);
      assert.ok(presetWorkflow(state.record.templateId));
      assert.equal(state.loadedSkills.has("paper-deep-reading"), true);
      // Editing the prompt does not remove the structured preset.
      state.record.draft!.text += " 不要生成额外标注。";
      assert.equal(state.record.templateId, "deep-read");
      await setTaskPreset(state, null, persist);
      const restored = JSON.parse(saved);
      assert.equal(restored.record.templateId, undefined);
      assert.equal(presetWorkflow(restored.record.templateId), undefined);
      assert.deepEqual(restored.loadedSkills, ["custom-skill"]);
      assert.deepEqual(restored.record.draft, state.record.draft);
      assert.deepEqual(
        restored.record.draft.references,
        original.draft!.references,
      );
      for (const key of [
        "id",
        "title",
        "backend",
        "mode",
        "permissionMode",
        "lockedContext",
        "artifactIds",
      ] as const)
        assert.deepEqual(restored.record[key], original[key]);
    });
  }

  it("switching presets removes only the previous preset's implicit skill", async () => {
    const state = task();
    await setTaskPreset(state, "deep-read", async () => {});
    await setTaskPreset(state, "evidence-audit", async () => {});
    assert.equal(state.record.templateId, "evidence-audit");
    assert.deepEqual([...state.loadedSkills], ["custom-skill"]);
  });

  it("keeps the preset and skills intact when persistence fails", async () => {
    const state = task();
    await setTaskPreset(state, "deep-read", async () => {});
    const before = structuredClone(state);
    for (const next of [null, "evidence-audit"]) {
      await assert.rejects(
        setTaskPreset(state, next, async () => {
          throw new Error("Disk full");
        }),
        /Disk full/,
      );
      assert.deepEqual(state, before);
    }
  });

  it("rejects invalid choices and changes to running or approval-waiting research", async () => {
    const state = task();
    const persist = async () => {
      assert.fail("Rejected preset changes must not persist");
    };
    for (const invalid of [undefined, "", "unknown"])
      await assert.rejects(
        setTaskPreset(state, invalid, persist),
        /Unknown task template/,
      );
    for (const status of ["running", "awaiting_approval"] as const) {
      state.record.status = status;
      await assert.rejects(
        setTaskPreset(state, null, persist),
        /running research/,
      );
    }
    state.record.status = "ready";
    state.activeTurnId = "starting-turn";
    await assert.rejects(
      setTaskPreset(state, "deep-read", persist),
      /running research/,
    );
  });
});

for (const id of ["deep-read", "evidence-audit", "synthesis"] as const) {
  it(`${id} exposes evidence and deliverable tools together without a phase switch`, () => {
    const preset = presetWorkflow(id)!;
    const names = presetToolNames(preset);
    assert(names.has("get_pages"));
    assert(names.has("artifact_upsert"));
    assert(names.has("artifact_read"));
    assert(names.has("artifact_patch"));
    if (id === "deep-read") assert(names.has("commit_annotations"));
    assert(preset.requiredArtifactKinds.length > 0);
    assert.doesNotMatch(
      preset.instruction,
      /STAGE [123]|handoff and stop|artifact_upsert is unavailable/,
    );
  });
}
it("task source filtering permits current sources and rejects another source independent of order", async () => {
  const scope = {
    itemRefs: new Set(["1:PDF"]),
    collectionRefs: new Set<string>(),
    savedSearchRefs: new Set<string>(),
  };
  assert.equal(
    presetToolCallInScope(scope, "get_pages", { libraryID: 1, key: "PDF" }),
    true,
  );
  assert.equal(
    presetToolCallInScope(scope, "get_pages", { libraryID: 1, key: "OTHER" }),
    false,
  );
  assert.equal(
    presetToolCallInScope(scope, "artifact_upsert", { kind: "deep_read" }),
    true,
  );
  const inner = new MemoryToolProvider();
  const provider = new PresetToolProvider(
    inner,
    presetWorkflow("deep-read")!,
    scope,
  );
  const denied = await provider.call("get_pages", {
    libraryID: 1,
    key: "OTHER",
  });
  assert.equal(denied.ok, false);
});
it("button and supported continue text route to the same run", () => {
  assert(isContinueRequest("继续吧！"));
  assert(isContinueRequest("resume"));
  assert(!isContinueRequest("继续分析另一个问题"));
});

it("resolves an annotation's native source again for execution and rejects another PDF even with stale context", async () => {
  const writes: string[] = [];
  const inner: ToolProvider = {
    listTools: () => [],
    getMeta: () => null,
    getSchema: () => undefined,
    prepare: async (_name, args, context = {}) => {
      context.resources = [`zotero:1:${args.key === "MARK" ? "PDF" : "OTHER"}`];
      return null;
    },
    call: async (name, args, _signal, context) => {
      assert.deepEqual(context?.resources, ["zotero:1:PDF"]);
      writes.push(String(args.key));
      return {
        ok: true,
        toolName: name,
        effect: "applied",
        data: { key: args.key },
      };
    },
  };
  const provider = new PresetToolProvider(inner, presetWorkflow("deep-read")!, {
    itemRefs: new Set(["1:PDF"]),
    collectionRefs: new Set(),
    savedSearchRefs: new Set(),
  });
  assert.equal(
    (
      await provider.call(
        "update_annotation_comment",
        { libraryID: 1, key: "MARK", comment: "Corrected evidence" },
        undefined,
        { taskId: "task" },
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await provider.call(
        "update_annotation_comment",
        { libraryID: 1, key: "OUTSIDE", comment: "Wrong source" },
        undefined,
        { resources: ["zotero:1:PDF"] },
      )
    ).ok,
    false,
  );
  assert.deepEqual(writes, ["MARK"]);
});
