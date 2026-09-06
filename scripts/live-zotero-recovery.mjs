#!/usr/bin/env node

/**
 * Real Zotero partial annotation recovery, through paired AgentHost task/toolCall.
 * This exercises domain preparation, task permission policy, canonical receipts,
 * and native writes. It deliberately does not claim model/RunCoordinator coverage.
 *
 * node --import tsx scripts/live-zotero-recovery.mjs --validate
 * CONFUCIUS_RECOVERY_FIXTURE_REPORT=output/tool-e2e-fourth-run.json \
 *   node --import tsx scripts/live-zotero-recovery.mjs
 *
 * Requires the development profile and a clean URL attachment from the core live
 * suite. Never changes model endpoints. Created annotations are removed after
 * verification unless CONFUCIUS_RECOVERY_KEEP_ANNOTATIONS=1 is explicitly set.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateArgs } from "@confucius/harness";
import { TOOL_DEFINITIONS } from "@confucius/zotero-tools";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILE = resolve(ROOT, "apps/zotero-addon/.scaffold/profile");
const DATA = resolve(ROOT, "apps/zotero-addon/.scaffold/data");
const FIXTURE_REPORT = resolve(
  ROOT,
  process.env.CONFUCIUS_RECOVERY_FIXTURE_REPORT ||
    "output/tool-e2e-fourth-run.json",
);
const REPORT = resolve(
  ROOT,
  process.env.CONFUCIUS_RECOVERY_REPORT || "output/zotero-recovery-report.json",
);
const KEEP = process.env.CONFUCIUS_RECOVERY_KEEP_ANNOTATIONS === "1";

function annotationPlan(runId) {
  // Exact, non-overlapping passages from scripts/create-tool-e2e-pdf.py.
  const passages = [
    [1, "Confucius verifies real PDF highlighting."],
    [1, "This deterministic paper exists solely to verify Zotero library"],
    [1, "Its wording is stable"],
    [1, "A reliable tool test needs a known document"],
    [1, "Searching for that token should return exactly this context."],
    [2, "The verification sequence creates a collection"],
    [2, "A passing implementation reports structured tool results"],
    [2, "The matrix records pass, fail, and blocked outcomes."],
    [3, "Fallback behavior must be labeled honestly."],
    [
      3,
      "This fixture is intentionally small, searchable, and visually plain enough",
    ],
  ];
  const repaired = passages.map(([page, quote], index) => ({
    id: `${runId}_entry_${String(index + 1).padStart(2, "0")}`,
    type: "highlight",
    page,
    quote,
    comment: `${runId}: entry ${index + 1} verifies that a grounded passage retains its native annotation identity across partial recovery.`,
  }));
  const first = repaired.map((entry, index) => ({
    ...entry,
    page: index < 8 ? entry.page : index - 7,
  }));
  assert.deepEqual(first.slice(0, 8), repaired.slice(0, 8));
  for (const index of [8, 9]) {
    assert.notEqual(first[index].page, repaired[index].page);
    assert.deepEqual({ ...first[index], page: 3 }, repaired[index]);
  }
  const schema = TOOL_DEFINITIONS.find(
    (tool) => tool.name === "propose_annotations",
  ).inputSchema;
  for (const annotations of [first, repaired])
    assert.equal(
      validateArgs("propose_annotations", schema, {
        libraryID: 1,
        key: "FIXTURE1",
        annotations,
      }),
      null,
    );
  return { first, repaired };
}

function preferences(source) {
  const values = new Map();
  for (const match of source.matchAll(/user_pref\("([^"]+)",\s*(.+?)\);/g)) {
    try {
      values.set(match[1], JSON.parse(match[2]));
    } catch {
      /* unrelated preference syntax */
    }
  }
  return values;
}

function nativeAnnotations(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.data.annotations));
  return result.data.annotations;
}

async function main() {
  const runId = `recovery_${Date.now().toString(36)}`;
  const plan = annotationPlan(runId);
  if (process.argv.includes("--validate")) {
    console.log(
      "Validated 10 schema-valid entries, 8 unchanged entries and 2 page-only repairs; no Zotero API calls performed.",
    );
    return;
  }
  const prefs = preferences(await readFile(join(PROFILE, "prefs.js"), "utf8"));
  const token = String(
    prefs.get("extensions.zotero.confucius.pairingToken") || "",
  );
  const port = Number(prefs.get("extensions.zotero.httpServer.port"));
  if (!token || !Number.isInteger(port) || port === 23119)
    throw new Error(
      "A paired non-default development-profile port is required",
    );
  const listeners = execFileSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\s+/);
  const row = execFileSync("ps", ["ax", "-o", "pid=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .find(
      (line) =>
        listeners.includes(line.trim().split(/\s+/)[0]) &&
        line.includes(`-profile ${PROFILE}`) &&
        line.includes(`--dataDir ${DATA}`),
    );
  if (!row)
    throw new Error(
      "The HTTP listener is not the expected development profile; no writes performed",
    );

  const core = JSON.parse(await readFile(FIXTURE_REPORT, "utf8"));
  assert.equal(resolve(core.developmentProfile.path), PROFILE);
  const attachment = core.createdResources.find(
    (entry) =>
      entry.tool === "attach_file" && entry.arguments?.url && entry.result?.key,
  );
  assert.ok(
    attachment,
    "The core report must contain its clean URL attachment",
  );
  const fixture = {
    libraryID: Number(attachment.arguments.libraryID || 1),
    key: attachment.arguments.key,
    attachmentKey: attachment.result.key,
  };
  assert.match(String(fixture.key), /^[A-Z0-9]{8}$/);
  assert.match(String(fixture.attachmentKey), /^[A-Z0-9]{8}$/);
  const origin = `http://127.0.0.1:${port}`;
  const report = {
    runId,
    startedAt: new Date().toISOString(),
    scope:
      "AgentHost paired task/toolCall: domain preparation, task auto_allow, receipts, native annotations; no model or Coordinator assertions",
    developmentProfile: {
      path: PROFILE,
      dataPath: DATA,
      pid: Number(row.trim().split(/\s+/)[0]),
    },
    fixtureReport: FIXTURE_REPORT,
    fixture,
    configurationMutated: false,
    trace: [],
    checks: [],
    cleanup: [],
    status: "running",
  };
  let sessionId,
    originalConfig,
    sequence = 0,
    hostUnavailable = false;
  const createdKeys = new Set();
  const rpc = async (method, params = {}) => {
    if (hostUnavailable)
      throw new Error(
        "Host unavailable; writes are not replayed automatically",
      );
    let response, payload;
    try {
      response = await fetch(`${origin}/confucius/v1/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++sequence,
          method,
          params,
        }),
      });
      payload = await response.json();
    } catch {
      hostUnavailable = true;
      throw new Error(
        "Development Zotero response was lost; stop and reconcile the recorded operation IDs before repeating any write",
      );
    }
    if (!response.ok || payload.error)
      throw new Error(payload.error?.message || `RPC HTTP ${response.status}`);
    return payload.result;
  };
  const call = async (name, args, phase = "verification") => {
    const operationId = `${runId}_call_${++sequence}`;
    const entry = {
      phase,
      name,
      operationId,
      arguments: args,
      startedAt: Date.now(),
    };
    report.trace.push(entry);
    const response = await rpc("task/toolCall", {
      taskId: sessionId,
      callId: operationId,
      operationId,
      name,
      arguments: args,
    });
    const content = response.content?.find((block) => block.type === "text");
    assert.ok(content, "AgentHost did not return an MCP tool receipt");
    const result = JSON.parse(content.text);
    entry.elapsedMs = Date.now() - entry.startedAt;
    entry.result = result;
    if (name === "commit_annotations")
      for (const saved of result.data?.committed ??
        result.details?.committed ??
        [])
        if (saved.annotationKey) createdKeys.add(saved.annotationKey);
    console.log(
      `${phase}: ${name} -> ${result.effect ?? (result.ok ? "ok" : result.code)}`,
    );
    return result;
  };
  const check = (name, evidence) => {
    report.checks.push({ name, status: "pass", evidence });
  };
  try {
    originalConfig = await rpc("config/get");
    const backupDirectory = await mkdtemp(
      join(tmpdir(), "confucius-recovery-"),
    );
    report.privateBackupPath = join(backupDirectory, "original-config.json");
    const backup = await open(report.privateBackupPath, "wx", 0o600);
    try {
      await backup.writeFile(JSON.stringify({ origin, originalConfig }));
      await backup.sync();
    } finally {
      await backup.close();
    }
    const now = Date.now();
    const task = await rpc("session/new", {
      title: `Annotation recovery ${runId}`,
      titleState: "fixed",
      backend: "native",
      mode: "agent",
      lockedContext: {
        version: 1,
        capturedAt: now,
        fingerprint: "development-recovery-fixture",
        items: [
          {
            id: `item:${fixture.libraryID}:${fixture.key}`,
            libraryID: fixture.libraryID,
            key: fixture.key,
            title: "Deterministic annotation recovery fixture",
            source: "library",
            attachmentKey: fixture.attachmentKey,
          },
        ],
        reader: {
          id: `reader:${fixture.libraryID}:${fixture.attachmentKey}`,
          libraryID: fixture.libraryID,
          attachmentKey: fixture.attachmentKey,
          parentKey: fixture.key,
          title: "Recovery fixture PDF",
          pageIndex: 0,
          pageLabel: "1",
        },
      },
    });
    sessionId = task.id;
    report.taskId = sessionId;
    await rpc("session/setPermissions", {
      sessionId,
      permissionMode: "auto_allow",
    });
    check("explicit_development_task_permission_and_sources", {
      permissionMode: "auto_allow",
      lockedContext: task.lockedContext,
    });

    const baseline = nativeAnnotations(await call("get_annotations", fixture));
    assert.equal(
      baseline.length,
      0,
      "Use the clean URL attachment, not the annotated core fixture",
    );
    const pages = new Map();
    for (const page of [1, 2, 3]) {
      const result = await call("get_pages", {
        ...fixture,
        start: page,
        end: page,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.data.pageSource, "pdf_physical");
      assert.equal(result.data.pages?.length, 1);
      assert.equal(result.data.pages[0].page, page);
      pages.set(page, String(result.data.pages[0].text).replace(/\s+/g, " "));
    }
    for (const entry of plan.repaired)
      assert.ok(
        pages.get(entry.page).includes(entry.quote),
        `Actual physical page ${entry.page} is missing ${entry.id}`,
      );
    for (const entry of plan.first.slice(8))
      assert.equal(pages.get(entry.page).includes(entry.quote), false);
    check("real_quotes_and_schema_valid_wrong_pages", {
      correctPageCount: 3,
      correctInitialEntries: 8,
      wrongPageEntries: plan.first.slice(8),
    });

    const proposed = await call(
      "propose_annotations",
      { ...fixture, annotations: plan.first },
      "initial",
    );
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    assert.equal(proposed.data.count, 10);
    assert.deepEqual(proposed.data.issues, []);
    const first = await call(
      "commit_annotations",
      { ...fixture, proposalId: proposed.data.proposalId },
      "initial",
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.effect, "partial");
    assert.equal(first.data.committed.length, 8);
    assert.equal(first.data.skipped.length, 2);
    assert.deepEqual(
      first.data.skipped.map((entry) => entry.id).sort(),
      plan.first
        .slice(8)
        .map((entry) => entry.id)
        .sort(),
    );
    const firstActual = nativeAnnotations(
      await call("get_annotations", fixture, "initial-proof"),
    );
    assert.equal(firstActual.length, 8);
    const firstKeys = first.data.committed
      .map((entry) => entry.annotationKey)
      .sort();
    assert.deepEqual(firstActual.map((entry) => entry.key).sort(), firstKeys);
    check("initial_8_of_10_are_native_annotations", {
      keys: firstKeys,
      skipped: first.data.skipped,
    });

    const updated = await call(
      "propose_annotations",
      { ...fixture, annotations: plan.repaired },
      "repair",
    );
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.notEqual(updated.data.proposalId, proposed.data.proposalId);
    assert.deepEqual(
      updated.data.annotations.map((entry) => entry.id),
      proposed.data.annotations.map((entry) => entry.id),
    );
    const repaired = await call(
      "commit_annotations",
      { ...fixture, proposalId: updated.data.proposalId },
      "repair",
    );
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(repaired.data.committed.length, 2);
    assert.equal(repaired.data.alreadyPresent.length, 8);
    assert.equal(repaired.data.count, 10);
    assert.deepEqual(
      repaired.data.alreadyPresent.map((entry) => entry.annotationKey).sort(),
      firstKeys,
    );
    // A fresh operation ID proves domain reconciliation, not only receipt replay.
    // There is deliberately no get_annotations between these two commits.
    const repeated = await call(
      "commit_annotations",
      { ...fixture, proposalId: updated.data.proposalId },
      "repeat-without-read",
    );
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(repeated.effect, "none");
    assert.equal(repeated.data.committed.length, 0);
    assert.equal(repeated.data.alreadyPresent.length, 10);
    check("repair_only_adds_two_and_repeat_adds_none", {
      repaired: repaired.data,
      repeated: repeated.data,
    });

    const finalActual = nativeAnnotations(
      await call("get_annotations", fixture, "final-proof"),
    );
    assert.equal(finalActual.length, 10);
    assert.equal(new Set(finalActual.map((entry) => entry.key)).size, 10);
    for (const key of firstKeys)
      assert.ok(finalActual.some((entry) => entry.key === key));
    for (const draft of plan.repaired) {
      const actual = finalActual.find(
        (entry) => entry.comment === draft.comment,
      );
      assert.ok(actual, `No native annotation for stable entry ${draft.id}`);
      assert.equal(actual.text, draft.quote);
      assert.equal(actual.position.pageIndex + 1, draft.page);
      assert.ok(actual.position.rects.length > 0);
    }
    check("ten_final_entities_with_first_eight_keys_unchanged", finalActual);
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    if (sessionId && !hostUnavailable) {
      try {
        if (!KEEP) {
          for (const key of createdKeys) {
            const result = await call(
              "delete_annotation",
              { libraryID: fixture.libraryID, key },
              "cleanup",
            );
            assert.equal(result.ok, true, JSON.stringify(result));
          }
          report.cleanup.push({
            check: "created_annotations_removed",
            status: "pass",
            keys: [...createdKeys],
          });
        } else
          report.cleanup.push({
            check: "created_annotations",
            status: "retained_for_inspection",
            keys: [...createdKeys],
          });
        await rpc("session/delete", { sessionId });
        report.cleanup.push({
          check: "temporary_task_deleted",
          status: "pass",
        });
      } catch (error) {
        report.cleanup.push({
          check: "fixture_cleanup",
          status: "fail",
          error: String(error),
        });
        process.exitCode = 1;
      }
    }
    if (originalConfig && !hostUnavailable) {
      try {
        assert.deepEqual(await rpc("config/get"), originalConfig);
        report.cleanup.push({
          check: "global_configuration_unchanged",
          status: "pass",
        });
      } catch (error) {
        report.cleanup.push({
          check: "global_configuration_unchanged",
          status: "fail",
          error:
            "Configuration differs or is unreadable; inspect the private backup",
        });
        process.exitCode = 1;
      }
    }
    report.hostUnavailable = hostUnavailable;
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(REPORT), { recursive: true });
    await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Recovery report: ${REPORT}`);
    console.log(
      `Result: ${report.status}; ${report.checks.length} checks passed; configuration was not modified by this script.`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
