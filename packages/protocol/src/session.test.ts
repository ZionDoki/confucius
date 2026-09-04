import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrateSessionRecord, type SessionRecord } from "./session";

describe("schema v1 to v2 migration", () => {
  it("migrates legacy sessions to safe native tasks", () => {
    const legacy: SessionRecord = {
      id: "ses_old",
      title: "Legacy research",
      createdAt: 10,
      updatedAt: 20,
      mode: "agent",
      context: { item: { libraryID: 1, key: "ABC" } },
      permissionMode: "auto_allow",
    };
    const task = migrateSessionRecord(legacy, 30);
    assert.equal(task.schemaVersion, 2);
    assert.equal(task.backend, "native");
    assert.equal(task.capabilityProfile, "zotero_only");
    assert.equal(task.status, "ready");
    assert.equal(task.titleState, "fixed");
    assert.deepEqual(
      task.lockedContext.items.map((item) => item.key),
      ["ABC"],
    );
  });

  it("repairs unsafe or incomplete v2 fields", () => {
    const task = migrateSessionRecord({
      id: "ses_v2",
      title: "V2",
      createdAt: 1,
      updatedAt: 1,
      mode: "agent",
      context: {},
      permissionMode: "ask",
      schemaVersion: 2,
      backend: "removed_external_backend",
      status: "bad",
      lockedContext: {
        version: 1,
        capturedAt: 1,
        fingerprint: "stale",
        items: [],
      },
      artifactIds: ["a", "a"],
      capabilityProfile: "workspace",
      externalSessionId: "must-not-survive-native-repair",
      recoverableTurn: {
        turnId: "bad",
        userText: "stale",
        checkpointAt: 1,
        iteration: -1,
        unknownToolCallIds: [],
      },
    } as never);
    assert.equal(task.backend, "native");
    assert.equal(task.status, "ready");
    assert.deepEqual(task.artifactIds, ["a"]);
    assert.equal(task.capabilityProfile, "zotero_only");
    assert.equal(task.workingDirectory, undefined);
    assert.equal(task.externalSessionId, undefined);
    assert.equal(task.recoverableTurn, undefined);
    assert.equal(task.titleState, "fixed");
    assert.notEqual(task.lockedContext.fingerprint, "stale");
  });

  it("keeps only valid recovery state for an interrupted task", () => {
    const task = migrateSessionRecord({
      id: "ses_interrupted",
      title: "Interrupted",
      createdAt: 1,
      updatedAt: 2,
      mode: "agent",
      context: {},
      permissionMode: "ask",
      schemaVersion: 2,
      backend: "kimi",
      status: "interrupted",
      lockedContext: {
        version: 1,
        capturedAt: 1,
        fingerprint: "stale",
        items: [],
      },
      artifactIds: ["art_1", "../outside"],
      capabilityProfile: "zotero_only",
      recoverableTurn: {
        turnId: "turn_1",
        userText: "continue",
        checkpointAt: 2,
        iteration: 1,
        unknownToolCallIds: ["call_1", "call_1"],
      },
    });
    assert.deepEqual(task.artifactIds, ["art_1"]);
    assert.deepEqual(task.recoverableTurn?.unknownToolCallIds, ["call_1"]);
  });

  it("keeps historical unnamed tasks pending for post-restore repair", () => {
    const task = migrateSessionRecord({
      id: "ses_untitled",
      title: "未命名研究任务",
      createdAt: 1,
      updatedAt: 2,
      mode: "agent",
      context: {},
      permissionMode: "ask",
    });
    assert.equal(task.titleState, "pending");
  });
});
