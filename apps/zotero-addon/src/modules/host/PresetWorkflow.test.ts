import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelMessage } from "@confucius/harness";
import type { ArtifactKind, ConfuciusEvent } from "@confucius/protocol";
import {
  emptyLockedContext,
  type ResearchTaskRecord,
} from "@confucius/protocol";
import { setTaskPreset } from "./TaskPreset";
import {
  buildWorkflowHandoff,
  buildWorkflowHandoffFromEvents,
  eventToolWasRequested,
  presetWorkflow,
  presetResearchToolCallInScope,
  presetResearchToolNames,
  runDeliveryStageWithRetry,
  successfulArtifactKinds,
  successfulArtifactKindsFromEvents,
  toolWasRequested,
} from "./PresetWorkflow";

describe("task preset selection", () => {
  function task(backend: ResearchTaskRecord["backend"] = "native") {
    const record: ResearchTaskRecord = {
      id: "preset-task",
      title: "Research draft",
      titleState: "fixed",
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 3,
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

describe("preset research workflows", () => {
  it("defines separate research and delivery contexts for all featured modes", () => {
    for (const id of ["deep-read", "evidence-audit", "synthesis"] as const) {
      const workflow = presetWorkflow(id);
      assert.ok(workflow);
      assert.match(
        workflow.researchInstruction,
        /artifact_upsert is unavailable/i,
      );
      assert.match(workflow.researchInstruction, /user's instruction applies/i);
      assert.match(workflow.researchInstruction, /task context/i);
      assert.match(workflow.deliveryInstruction, /attached handoff/i);
      assert.doesNotMatch(
        `${workflow.researchInstruction}\n${workflow.deliveryInstruction}`,
        /locked context|sensible defaults|fresh context|autonomously|efficiently|immediately/i,
      );
    }
    assert.equal(presetWorkflow("deep-read")?.source, "single");
    assert.equal(presetWorkflow("evidence-audit")?.source, "single");
    assert.equal(presetWorkflow("synthesis")?.source, "multi");
    assert.equal(presetWorkflow("compare"), undefined);
  });

  it("keeps the default deep-reading annotation model inside stage one", () => {
    const workflow = presetWorkflow("deep-read");
    assert.ok(workflow);
    assert.match(workflow.researchInstruction, /#ffd400/);
    assert.match(workflow.researchInstruction, /#2ea8e5/);
    assert.match(workflow.researchInstruction, /#a28ae5/);
    assert.match(workflow.researchInstruction, /propose_annotations/);
    assert.match(workflow.researchInstruction, /commit_annotations/);
  });

  it("isolates preset research tools from memory, broad discovery, and delivery", () => {
    const deepRead = presetWorkflow("deep-read");
    const synthesis = presetWorkflow("synthesis");
    assert.ok(deepRead);
    assert.ok(synthesis);
    const deepReadTools = presetResearchToolNames(deepRead);
    const synthesisTools = presetResearchToolNames(synthesis);

    assert.equal(deepReadTools.has("get_pages"), true);
    assert.equal(deepReadTools.has("get_collection_items"), true);
    assert.equal(deepReadTools.has("propose_annotations"), true);
    assert.equal(deepReadTools.has("commit_annotations"), true);
    assert.equal(synthesisTools.has("propose_annotations"), false);
    for (const excluded of [
      "memory_search",
      "knowledge_base_get",
      "conversation_log_search",
      "search_items",
      "artifact_upsert",
    ]) {
      assert.equal(deepReadTools.has(excluded), false, excluded);
      assert.equal(synthesisTools.has(excluded), false, excluded);
    }
  });

  it("rejects source identifiers outside the host-resolved preset scope", () => {
    const scope = {
      itemRefs: new Set(["1:ALPHA", "1:ALPHA_PDF", "1:BETA"]),
      collectionRefs: new Set(["1:COLLECTION"]),
      savedSearchRefs: new Set(["2:SEARCH"]),
    };

    assert.equal(
      presetResearchToolCallInScope(scope, "get_pages", {
        libraryID: 1,
        key: "ALPHA",
      }),
      true,
    );
    assert.equal(
      presetResearchToolCallInScope(scope, "inspect_pdf_page", {
        libraryID: 1,
        key: "ALPHA_PDF",
      }),
      true,
    );
    assert.equal(
      presetResearchToolCallInScope(scope, "get_collection_items", {
        libraryID: 1,
        key: "COLLECTION",
      }),
      true,
    );
    assert.equal(
      presetResearchToolCallInScope(scope, "run_saved_search", {
        libraryID: 2,
        key: "SEARCH",
      }),
      true,
    );
    assert.equal(
      presetResearchToolCallInScope(scope, "get_pages", {
        libraryID: 1,
        key: "OLD_MEMORY_KEY",
      }),
      false,
    );
    assert.equal(
      presetResearchToolCallInScope(scope, "get_collection_items", {
        libraryID: 1,
        key: "OTHER_COLLECTION",
      }),
      false,
    );
  });

  it("recognizes a commit request even when the approval is denied", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "commit-1",
            name: "commit_annotations",
            args: { libraryID: 1, key: "PAPER", annotations: [] },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "commit-1",
        content: JSON.stringify({
          ok: false,
          toolName: "commit_annotations",
          code: "permission_denied",
        }),
      },
    ];
    assert.equal(toolWasRequested(messages, "commit_annotations"), true);
  });

  it("requires successful artifact results instead of calls alone", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "failed",
            name: "artifact_upsert",
            args: { kind: "deep_read" },
          },
          {
            id: "saved",
            name: "artifact_upsert",
            args: { kind: "annotation_set" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "failed",
        content: JSON.stringify({
          ok: false,
          toolName: "artifact_upsert",
        }),
      },
      {
        role: "tool",
        toolCallId: "saved",
        content: JSON.stringify({
          ok: true,
          toolName: "artifact_upsert",
        }),
      },
    ];
    assert.deepEqual(
      [...successfulArtifactKinds(messages)],
      ["annotation_set"],
    );
  });

  it("hands tool evidence to the delivery context without transient media", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: "working notes",
        toolCalls: [
          {
            id: "read-1",
            name: "get_pages",
            args: { libraryID: 1, key: "PAPER", start: 1, end: 2 },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read-1",
        content: '{"ok":true,"data":{"pages":["evidence"]}}',
      },
      {
        role: "user",
        content: "temporary image",
        images: [{ mimeType: "image/png", data: "SECRET-IMAGE" }],
        transient: true,
      },
    ];
    const handoff = buildWorkflowHandoff(messages);
    assert.match(handoff, /working notes/);
    assert.match(handoff, /get_pages/);
    assert.match(handoff, /evidence/);
    assert.doesNotMatch(handoff, /TOOL REQUEST get_pages/);
    assert.doesNotMatch(handoff, /SECRET-IMAGE/);
  });

  it("builds and audits an external-runtime handoff from durable events", () => {
    const base = {
      sessionId: "task-1",
      turnId: "turn-1",
      ts: 1,
    };
    const events: ConfuciusEvent[] = [
      {
        ...base,
        id: "request",
        type: "tool_requested",
        payload: {
          callId: "commit-1",
          toolName: "commit_annotations",
          args: { annotations: [{ type: "highlight", quote: "evidence" }] },
        },
      },
      {
        ...base,
        id: "result",
        type: "tool_result",
        payload: {
          callId: "commit-1",
          result: {
            ok: false,
            toolName: "commit_annotations",
            code: "permission_denied",
            message: "denied",
          },
        },
      },
      {
        ...base,
        id: "artifact",
        type: "artifact_upserted",
        payload: {
          artifact: {
            id: "artifact-1",
            taskId: "task-1",
            sessionId: "task-1",
            kind: "deep_read",
            title: "Deep read",
            status: "draft",
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
    ];

    const handoff = buildWorkflowHandoffFromEvents(events, "grounded notes");
    assert.match(handoff, /commit_annotations/);
    assert.match(handoff, /permission_denied/);
    assert.match(handoff, /grounded notes/);
    assert.equal(eventToolWasRequested(events, "commit_annotations"), true);
    assert.deepEqual(
      [...successfulArtifactKindsFromEvents(events)],
      ["deep_read"],
    );
  });

  it("retries only delivery and asks the retry for still-missing artifacts", async () => {
    const completed = new Set<ArtifactKind>();
    const attempts: Array<{
      attempt: number;
      missing: readonly ArtifactKind[];
    }> = [];
    let retries = 0;

    const result = await runDeliveryStageWithRetry({
      requiredArtifactKinds: ["deep_read", "annotation_set"],
      successfulArtifactKinds: () => completed,
      runAttempt: async ({ attempt, missingArtifactKinds }) => {
        attempts.push({ attempt, missing: [...missingArtifactKinds] });
        if (attempt === 0) {
          // Simulate a gateway failure after one durable artifact landed.
          completed.add("deep_read");
          return { phase: "failed" as const };
        }
        completed.add("annotation_set");
        return { phase: "done" as const };
      },
      isFailure: (value) => value.phase === "failed",
      beforeRetry: () => {
        retries += 1;
      },
    });

    assert.equal(result.phase, "done");
    assert.equal(retries, 1);
    assert.deepEqual(attempts, [
      { attempt: 0, missing: ["deep_read", "annotation_set"] },
      { attempt: 1, missing: ["annotation_set"] },
    ]);
  });
});
