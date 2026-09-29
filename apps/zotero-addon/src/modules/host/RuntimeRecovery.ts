import {
  initialContextWindow,
  isArtifactRecord,
  migrateSessionRecord,
  taskContextReferences,
  temporaryTaskTitle,
  type ConfuciusEvent,
  type ContextWindowState,
  type HistoryItem,
  type ResearchTaskRecord,
} from "@confucius/protocol";
import type { MigrationFs } from "./RuntimeStorage";
import { compactTaskEvents } from "./TaskEventHistory";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const rows = (value: unknown): ObjectValue[] =>
  Array.isArray(value) ? value.map(object) : [];
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]+$/.test(value);
const timestamp = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string")
    : [];

function path(fs: MigrationFs, root: string, relative: string): string {
  const parts = relative.split("/");
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || part.includes("\\"),
    )
  )
    throw new Error("Unsafe runtime recovery path");
  return fs.join(root, ...parts);
}

async function filesUnder(
  fs: MigrationFs,
  root: string,
  relative: string,
): Promise<string[]> {
  if (relative.split("/").length > 32)
    throw new Error("Runtime directory nesting exceeds recovery limit");
  const target = path(fs, root, relative);
  if (!(await fs.exists(target))) return [];
  if (!(await fs.directory(target))) return [relative];
  const files: string[] = [];
  for (const child of (await fs.children(target)).sort())
    files.push(
      ...(await filesUnder(fs, root, `${relative}/${fs.basename(child)}`)),
    );
  return files;
}

async function copyVerified(
  fs: MigrationFs,
  from: string,
  root: string,
  relative: string,
): Promise<string> {
  const to = path(fs, root, relative);
  const parts = relative.split("/");
  await fs.mkdir(
    parts.length > 1 ? fs.join(root, ...parts.slice(0, -1)) : root,
  );
  const digest = await fs.digest(from);
  if (!(await fs.exists(to))) await fs.copy(from, to);
  if ((await fs.digest(to)) !== digest)
    throw new Error(`Runtime recovery checksum mismatch: ${relative}`);
  return digest;
}

/** Preserve every input before rebuilding projections. Retries never replace a
 * backup with different bytes, nor overwrite a task already saved in this profile. */
export async function recoverMissingTaskIndex(
  source: string,
  destination: string,
  fs: MigrationFs,
  recoveredAt: number,
): Promise<void> {
  const backup = fs.join(destination, "recovery", "missing-task-index");
  const issues: string[] = [];
  const preserved: Record<string, { path: string; sha256: string }> = {};
  const preserve = async (root: string, relative: string, origin: string) => {
    const from = path(fs, root, relative);
    const digest = await fs.digest(from);
    let target = `${origin}/${relative}`;
    if (
      (await fs.exists(path(fs, backup, target))) &&
      (await fs.digest(path(fs, backup, target))) !== digest
    )
      target += `.${digest}.backup`;
    await copyVerified(fs, from, backup, target);
    preserved[`${origin}/${relative}`] = { path: target, sha256: digest };
    return path(fs, backup, target);
  };
  const readJson = async (target: string): Promise<ObjectValue> => {
    // A malformed document is recoverable; filesystem failures must not be
    // confused with missing data or a successfully completed backup.
    const text = await fs.read(target);
    try {
      return object(JSON.parse(text));
    } catch {
      issues.push(`Invalid JSON retained in backup: ${target}`);
      return {};
    }
  };
  const originals = new Map<string, string>();
  const backupNames = [
    "state.json.pre-context-archive-backup",
    "state.json.pre-v4-backup",
  ];
  for (const name of ["history", "logs", "artifacts", ...backupNames])
    for (const relative of await filesUnder(fs, source, name))
      originals.set(relative, await preserve(source, relative, "source"));

  const currentPath = fs.join(destination, "state.json");
  const current = (await fs.exists(currentPath))
    ? await readJson(await preserve(destination, "state.json", "destination"))
    : {};
  const currentTasks = rows(current.tasks ?? current.sessions);
  if (
    (await fs.exists(currentPath)) &&
    !Array.isArray(current.tasks ?? current.sessions)
  )
    throw new Error(
      "Saved local task index is damaged; its backup was retained",
    );
  const existingIds = new Set(
    currentTasks.map((entry) => object(entry.record).id),
  );
  const savedTasks = new Map<string, ObjectValue>();
  for (const root of [destination, source]) {
    for (const name of backupNames) {
      const target =
        root === source
          ? originals.get(name)
          : (await fs.exists(fs.join(root, name)))
            ? await preserve(root, name, "destination")
            : undefined;
      if (!target) continue;
      const saved = await readJson(target);
      for (const entry of rows(saved.tasks ?? saved.sessions)) {
        const record = object(entry.record);
        if (id(record.id) && !savedTasks.has(record.id))
          savedTasks.set(record.id, entry);
      }
    }
  }

  // Existing local files win collisions. Both versions remain in the recovery
  // backup; an older library copy cannot replace a newer conversation or report.
  for (const [relative, original] of originals) {
    if (
      relative.endsWith(".tmp") ||
      !/^(history|logs|artifacts)\//.test(relative)
    )
      continue;
    const taskId = relative.split("/")[1];
    if (relative.startsWith("history/") && existingIds.has(taskId)) continue;
    const target = path(fs, destination, relative);
    if (await fs.exists(target)) {
      if ((await fs.digest(target)) !== (await fs.digest(original))) {
        await preserve(destination, relative, "destination");
        issues.push(`Kept newer local file: ${relative}`);
      }
    } else await copyVerified(fs, original, destination, relative);
  }

  const artifactIds = new Map<string, string[]>();
  for (const relative of await filesUnder(fs, destination, "artifacts")) {
    if (!/^artifacts\/[\w-]+\.json$/.test(relative)) continue;
    const artifact = await readJson(path(fs, destination, relative));
    if (
      isArtifactRecord(artifact) &&
      id(artifact.id) &&
      id(artifact.taskId) &&
      relative === `artifacts/${artifact.id}.json`
    ) {
      const ids = artifactIds.get(artifact.taskId) ?? [];
      ids.push(artifact.id);
      artifactIds.set(artifact.taskId, ids);
    }
  }
  const historyFiles = await filesUnder(fs, destination, "history");
  const taskIds = new Set([
    ...historyFiles.map((relative) => relative.split("/")[1]),
    ...artifactIds.keys(),
  ]);
  const recovered: Array<{
    record: ResearchTaskRecord;
    events: ConfuciusEvent[];
    messages: never[];
    sessionGrants: never[];
  }> = [];
  for (const taskId of [...taskIds].sort()) {
    if (!id(taskId) || existingIds.has(taskId)) continue;
    const prefix = `history/${taskId}/`;
    const taskFiles = historyFiles.filter((relative) =>
      relative.startsWith(prefix),
    );
    const indexPath = path(fs, destination, `${prefix}index.json`);
    let index = (await fs.exists(indexPath)) ? await readJson(indexPath) : {};
    if (index.deleted === true) continue;
    if (
      !Array.isArray(index.items) ||
      !Array.isArray(index.windows) ||
      !Array.isArray(index.notes)
    ) {
      const previous = path(fs, destination, `${prefix}index.pre-archive.json`);
      if (await fs.exists(previous)) index = await readJson(previous);
      if (index.deleted === true) continue;
    }
    const saved = savedTasks.get(taskId);
    const metadata = object(saved?.record);
    const createdAt = timestamp(metadata.createdAt, recoveredAt);
    const windows = new Map<string, ContextWindowState>();
    for (const window of rows(index.windows)) {
      if (!id(window.id)) continue;
      windows.set(window.id, {
        id: window.id,
        number:
          Number.isSafeInteger(window.number) && Number(window.number) > 0
            ? Number(window.number)
            : windows.size + 1,
        createdAt: timestamp(window.createdAt, createdAt),
        control: window.control === "runtime" ? "runtime" : "host",
        historyCoverage: "host-visible",
        usageSource: "unknown",
      });
    }
    const originalItems = new Map(
      rows(index.items)
        .filter((item) => id(item.windowId) && id(item.itemId))
        .map((item) => [`${item.windowId}/${item.itemId}`, item]),
    );
    const items: HistoryItem[] = [];
    const notes: Array<{
      name: string;
      revision: number;
      updatedAt: number;
      characters: number;
      sourceIds: string[];
    }> = [];
    const bodies = new Map<string, string>();
    const events = new Map<string, ConfuciusEvent>();
    const addEvents = (entries: unknown) => {
      for (const entry of rows(entries)) {
        const event = recoverDisplayEvent(entry, taskId);
        if (event) events.set(`${event.turnId ?? ""}:${event.id}`, event);
      }
    };
    if (!index.prunedAt) addEvents(saved?.events);
    // A retention tombstone takes precedence over bodies or older backups.
    for (const relative of index.prunedAt ? [] : taskFiles) {
      const suffix = relative.slice(prefix.length);
      const bodyMatch = /^windows\/([\w-]+)\/([\w-]+)\.txt$/.exec(suffix);
      const noteMatch = /^notes\/([\w-]+)_([1-9]\d*)\.txt$/.exec(suffix);
      if (!bodyMatch && !noteMatch) continue;
      const content = await fs.read(path(fs, destination, relative));
      if (noteMatch) {
        const revision = Number(noteMatch[2]);
        if (!Number.isSafeInteger(revision)) continue;
        const old = rows(index.notes).find(
          (note) => note.name === noteMatch[1] && note.revision === revision,
        );
        notes.push({
          name: noteMatch[1],
          revision,
          updatedAt: timestamp(old?.updatedAt, createdAt),
          characters: content.length,
          sourceIds: strings(old?.sourceIds),
        });
        continue;
      }
      const [, windowId, itemId] = bodyMatch!;
      if (!windows.has(windowId))
        windows.set(windowId, {
          ...initialContextWindow(taskId, "native", createdAt),
          id: windowId,
          number: windows.size + 1,
        });
      const candidate = originalItems.get(`${windowId}/${itemId}`);
      const old =
        candidate?.taskId === undefined || candidate.taskId === taskId
          ? candidate
          : undefined;
      const role = ["user", "assistant", "tool", "event"].includes(
        String(old?.role),
      )
        ? (old!.role as HistoryItem["role"])
        : itemId.startsWith("user_")
          ? "user"
          : itemId.startsWith("answer_")
            ? "assistant"
            : itemId.startsWith("tool_")
              ? "tool"
              : "event";
      const item: HistoryItem = {
        taskId,
        windowId,
        itemId,
        role,
        turnId: id(old?.turnId)
          ? old.turnId
          : /^(user|answer)_/.test(itemId)
            ? itemId.slice(itemId.indexOf("_") + 1)
            : undefined,
        purpose:
          old?.purpose === "diagnostic" || itemId.startsWith("trace_")
            ? "diagnostic"
            : undefined,
        createdAt: timestamp(old?.createdAt, windows.get(windowId)!.createdAt),
        sourceIds: strings(old?.sourceIds),
        toolName: typeof old?.toolName === "string" ? old.toolName : undefined,
        characters: content.length,
        excerpt: content.slice(0, 300),
        legacy: true,
        incomplete: !old || old.incomplete === true,
        delivery: "archived",
        verification: "unknown",
      };
      items.push(item);
      bodies.set(`${windowId}/${itemId}`, content);
      if (itemId.startsWith("trace_")) {
        try {
          const batch = object(JSON.parse(content));
          if (batch.kind === "confucius-trace-events") addEvents(batch.events);
        } catch {
          /* The original remains a readable diagnostic body. */
        }
      }
    }
    for (const old of originalItems.values())
      if (
        id(old.windowId) &&
        id(old.itemId) &&
        !bodies.has(`${old.windowId}/${old.itemId}`)
      )
        issues.push(
          `History body unavailable: ${prefix}windows/${old.windowId}/${old.itemId}.txt`,
        );
    for (const old of rows(index.notes))
      if (
        !notes.some(
          (note) => note.name === old.name && note.revision === old.revision,
        )
      )
        issues.push(
          `Working note unavailable: ${prefix}notes/${String(old.name)}_${String(old.revision)}.txt`,
        );
    const completedBodies = new Set(
      items
        .filter(
          (item) =>
            item.role === "assistant" && item.itemId.startsWith("answer_"),
        )
        .map((item) => item.turnId),
    );
    for (const [key, event] of events)
      if (
        event.type === "text_delta" &&
        event.payload.phase !== "commentary" &&
        completedBodies.has(event.turnId)
      )
        events.delete(key);
    const projected = new Set(
      [...events.values()]
        .filter(
          (event) =>
            event.type !== "text_delta" || event.payload.phase !== "commentary",
        )
        .map((event) => `${event.turnId}:${event.type}`),
    );
    items.sort((a, b) => a.createdAt - b.createdAt);
    for (const item of items) {
      if (item.role !== "user" && item.role !== "assistant") continue;
      const turnId = item.turnId ?? `recovered_${item.windowId}_${item.itemId}`;
      const type = item.role === "user" ? "turn_started" : "text_delta";
      if (projected.has(`${turnId}:${type}`)) continue;
      if (
        item.role === "assistant" &&
        completedBodies.has(item.turnId) &&
        !item.itemId.startsWith("answer_")
      )
        continue;
      const content = bodies.get(`${item.windowId}/${item.itemId}`)!;
      const base = {
        id: `recovered_${item.windowId}_${item.itemId}`,
        sessionId: taskId,
        turnId,
        ts: item.createdAt,
      };
      const event: ConfuciusEvent =
        item.role === "user"
          ? { ...base, type: "turn_started", payload: { userText: content } }
          : {
              ...base,
              type: "text_delta",
              payload: { text: content, phase: "final_answer" },
            };
      events.set(`${turnId}:${event.id}`, event);
    }
    const timeline = [...events.values()].sort((a, b) => a.ts - b.ts);
    const firstUser = timeline.find((event) => event.type === "turn_started");
    const titleEvent = [...timeline]
      .reverse()
      .find(
        (event) =>
          (event.type === "session_created" ||
            event.type === "session_updated") &&
          event.payload.title,
      );
    const title =
      typeof metadata.title === "string" && metadata.title.trim()
        ? metadata.title
        : titleEvent &&
            (titleEvent.type === "session_created" ||
              titleEvent.type === "session_updated")
          ? titleEvent.payload.title!
          : temporaryTaskTitle(
              firstUser?.type === "turn_started"
                ? firstUser.payload.userText
                : "",
              `Recovered task ${taskId}`,
            );
    const record = migrateSessionRecord(
      {
        id: taskId,
        title,
        createdAt: timestamp(
          metadata.createdAt,
          [
            ...items,
            ...timeline.map((event) => ({ createdAt: event.ts })),
          ].reduce((at, item) => Math.min(at, item.createdAt), createdAt),
        ),
        updatedAt: timestamp(
          metadata.updatedAt,
          timeline.at(-1)?.ts ?? createdAt,
        ),
        mode: metadata.mode === "plan" ? "plan" : "agent",
        context: {},
        permissionMode: "ask",
        schemaVersion: 4,
        backend: metadata.backend,
        runtimeModel: metadata.runtimeModel,
        lockedContext: metadata.lockedContext,
        createdFrom: metadata.createdFrom,
        references: metadata.references,
        templateId: metadata.templateId,
        reportStyle: metadata.reportStyle,
      } as ResearchTaskRecord,
      recoveredAt,
    );
    // Checkpoints, execution grants and incomplete write intents cannot be
    // inferred from conversation text. A restored archive is never auto-run.
    record.status = "interrupted";
    record.titleState = "fixed";
    record.artifactIds = artifactIds.get(taskId) ?? [];
    const draft = object(metadata.draft);
    if (typeof draft.text === "string")
      record.draft = {
        text: draft.text,
        references: taskContextReferences(draft.references),
      };
    let windowId = `ctx_${taskId}_recovered_${recoveredAt.toString(36)}`;
    while (
      windows.has(windowId) &&
      windows.get(windowId)!.createdAt !== recoveredAt
    )
      windowId += "_1";
    record.contextWindow = {
      ...initialContextWindow(taskId, record.backend, recoveredAt),
      id: windowId,
      number:
        windows.get(windowId)?.number ??
        [...windows.values()].reduce(
          (number, window) => Math.max(number, window.number),
          0,
        ) + 1,
    };
    windows.set(windowId, record.contextWindow);
    const open = new Set<string>();
    for (const event of timeline) {
      if (event.type === "turn_started" && event.turnId) open.add(event.turnId);
      if (
        ["turn_completed", "turn_failed", "turn_aborted"].includes(
          event.type,
        ) &&
        event.turnId
      )
        open.delete(event.turnId);
    }
    for (const turnId of open)
      timeline.push({
        id: `recovered_end_${turnId}`,
        sessionId: taskId,
        turnId,
        type: "turn_aborted",
        ts: recoveredAt,
        payload: { reason: "Task index recovered from saved history" },
      });
    if (await fs.exists(indexPath))
      await preserve(destination, `${prefix}index.json`, "destination");
    await fs.mkdir(path(fs, destination, `history/${taskId}`));
    await fs.write(
      indexPath,
      JSON.stringify({
        version: 1,
        windows: [...windows.values()],
        items,
        notes,
        ...(index.prunedAt ? { prunedAt: index.prunedAt } : {}),
      }),
    );
    recovered.push({
      record,
      events: compactTaskEvents(timeline, 2000),
      messages: [],
      sessionGrants: [],
    });
  }
  // Commit recovered tasks only after every archive and immutable backup is
  // durable. A retry after this write sees these IDs and leaves them unchanged.
  const reportPath = fs.join(backup, "report.json");
  const previousReport = (await fs.exists(reportPath))
    ? await readJson(reportPath)
    : {};
  await fs.write(
    reportPath,
    JSON.stringify({
      version: 1,
      recoveredAt,
      taskIds: [
        ...new Set([
          ...strings(previousReport.taskIds),
          ...recovered.map((entry) => entry.record.id),
        ]),
      ],
      issues: [...new Set([...strings(previousReport.issues), ...issues])],
      files: { ...object(previousReport.files), ...preserved },
    }),
  );
  await fs.write(
    currentPath,
    JSON.stringify({
      ...current,
      schemaVersion: 4,
      runtimeStorageVersion: 1,
      contextStorageVersion: 1,
      tasks: [...currentTasks, ...recovered],
      sessions: undefined,
    }),
  );
}

/** Recover display-only events. Historical tool calls, approvals and receipts
 * remain in the archive and cannot grant authority or replay an operation. */
function recoverDisplayEvent(
  value: ObjectValue,
  taskId: string,
): ConfuciusEvent | null {
  if (value.sessionId !== taskId || !id(value.id) || !Number.isFinite(value.ts))
    return null;
  const payload = object(value.payload);
  const base = {
    id: value.id,
    sessionId: taskId,
    turnId: id(value.turnId) ? value.turnId : undefined,
    ts: Number(value.ts),
  };
  switch (value.type) {
    case "turn_started":
      return typeof payload.userText === "string"
        ? {
            ...base,
            type: "turn_started",
            payload: { userText: payload.userText },
          }
        : null;
    case "text_delta":
      return typeof payload.text === "string"
        ? {
            ...base,
            type: "text_delta",
            payload: {
              text: payload.text,
              phase:
                payload.phase === "commentary" ? "commentary" : "final_answer",
            },
          }
        : null;
    case "session_created":
    case "session_updated":
      return typeof payload.title === "string"
        ? {
            ...base,
            type: "session_updated",
            payload: { title: payload.title },
          }
        : null;
    case "turn_completed":
      return { ...base, type: "turn_completed", payload: { phase: "done" } };
    case "turn_failed":
    case "turn_aborted":
      return {
        ...base,
        type: "turn_aborted",
        payload: {
          reason:
            typeof payload.reason === "string"
              ? payload.reason
              : "Interrupted historical turn",
        },
      };
    default:
      return null;
  }
}
