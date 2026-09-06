import type { ConfuciusEvent, TaskTraceReport } from "@confucius/protocol";

const CREDENTIAL =
  /^(?:api[-_]?key|authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|mcp[-_]?token|pairing[-_]?token|token)$/i;
const URL_SECRET =
  /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|key|signature|x-amz-signature|x-amz-credential)=)[^\s&#"'<>]+/gi;

/** Also inspect JSON encoded inside tool/history strings. Preserve Zotero keys and usage counts. */
export function redactTrace(value: unknown, secrets: readonly string[] = []) {
  const counts = { credentials: 0, binaryPayloads: 0 };
  const known = [...new Set(secrets.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  const replace = () => {
    counts.credentials++;
    return "[REDACTED]";
  };
  const text = (input: string): string => {
    let result = input;
    for (const secret of known) {
      // Local APIs sometimes use a dummy credential such as "1". Replacing
      // every occurrence would destroy IDs, page numbers and scientific data.
      // Short credentials remain covered in exact values and labelled fields.
      if (secret.length < 8) {
        if (result === secret) result = replace();
        continue;
      }
      result = result
        .split(secret)
        .map((part, i) => (i ? replace() + part : part))
        .join("");
    }
    result = result.replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=~:-]+/gi,
      (_m, scheme) => `${scheme} ${replace()}`,
    );
    result = result.replace(
      /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
      (_m, scheme) => `${scheme}${replace()}@`,
    );
    result = result.replace(
      URL_SECRET,
      (_m, prefix) => `${prefix}${replace()}`,
    );
    result = result.replace(
      /((?:api[-_]?key|authorization|password|access[-_]?token|refresh[-_]?token|client[-_]?secret)\s*[=:]\s*)([^\s,;"']+)/gi,
      (_m, prefix) => `${prefix}${replace()}`,
    );
    result = result.replace(
      /data:([\w.+-]+\/[\w.+-]+);base64,[A-Za-z0-9+/=\s]+/g,
      (_m, mime) => {
        counts.binaryPayloads++;
        return `[BINARY OMITTED: ${mime}]`;
      },
    );
    return result;
  };
  const walk = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (/^[[{]/.test(trimmed)) {
        try {
          return JSON.stringify(walk(JSON.parse(trimmed)));
        } catch {
          /* ordinary text */
        }
      }
      return text(entry);
    }
    if (Array.isArray(entry)) return entry.map(walk);
    if (!entry || typeof entry !== "object") return entry;
    if (entry instanceof Error)
      return {
        name: entry.name,
        message: text(entry.message),
        stack: text(entry.stack ?? ""),
      };
    const source = entry as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(source).map(([key, item]) => {
        if (
          CREDENTIAL.test(key) &&
          item !== null &&
          item !== undefined &&
          item !== ""
        )
          return [key, replace()];
        if (
          (key === "data" || key === "base64") &&
          typeof item === "string" &&
          (typeof source.mimeType === "string" || key === "base64")
        ) {
          counts.binaryPayloads++;
          return [key, `[BINARY OMITTED: ${item.length} encoded characters]`];
        }
        return [text(key), walk(item)];
      }),
    );
  };
  return { value: walk(value), counts };
}

export async function collectTaskTrace(input: {
  task: TaskTraceReport["task"];
  snapshot: unknown;
  retainedEvents: ConfuciusEvent[];
  startedAt: number;
  running: boolean;
  changed(): boolean;
  secrets: readonly string[];
  sections: Record<string, () => Promise<unknown>>;
}): Promise<TaskTraceReport> {
  const sections: TaskTraceReport["sections"] = {
    state: { capturedAt: input.startedAt, data: input.snapshot },
  };
  const issues: string[] = [];
  await Promise.all(
    Object.entries(input.sections).map(async ([name, read]) => {
      const capturedAt = Date.now();
      try {
        sections[name] = { capturedAt, data: await read() };
      } catch (error) {
        const message = String(error);
        sections[name] = { capturedAt, error: message };
        issues.push(`${name}: ${message}`);
      }
    }),
  );
  const events = new Map<string, ConfuciusEvent>();
  const addBatch = (content: unknown) => {
    if (typeof content !== "string") return;
    try {
      const batch = JSON.parse(content);
      if (
        batch.kind !== "confucius-trace-events" ||
        !Array.isArray(batch.events)
      )
        return;
      for (const event of batch.events) {
        if (
          event?.sessionId === input.task.id &&
          typeof event.id === "string" &&
          typeof event.type === "string" &&
          Number.isFinite(event.ts)
        )
          events.set(`${event.turnId ?? ""}:${event.id}`, event);
      }
    } catch {
      /* Other history bodies are text, preserved in their section. */
    }
  };
  const history = sections.history?.data as
    | {
        items?: Array<{ itemId: string; content?: string }>;
        unindexed?: Array<{ path: string; content?: string }>;
        issues?: string[];
      }
    | undefined;
  for (const item of history?.items ?? [])
    if (typeof item?.itemId === "string" && item.itemId.startsWith("trace_"))
      addBatch(item.content);
  for (const item of history?.unindexed ?? [])
    if (/\/trace_[\w-]+\.txt$/.test(item.path)) addBatch(item.content);
  issues.push(...(history?.issues ?? []).map((issue) => `history: ${issue}`));
  const pending = sections.pendingHistory?.data as
    Array<{ items: Array<{ itemId: string; content: string }> }> | undefined;
  for (const batch of pending ?? [])
    for (const item of batch.items)
      if (typeof item?.itemId === "string" && item.itemId.startsWith("trace_"))
        addBatch(item.content);
  const journalCount = events.size;
  for (const event of input.retainedEvents) {
    const key = `${event.turnId ?? ""}:${event.id}`;
    if (event.sessionId === input.task.id && !events.has(key))
      events.set(key, event);
  }
  const proposals = sections.annotationProposals?.data as
    { issues?: string[] } | undefined;
  issues.push(
    ...(proposals?.issues ?? []).map(
      (issue) => `annotationProposals: ${issue}`,
    ),
  );
  const report: TaskTraceReport = {
    kind: "confucius-task-trace",
    schemaVersion: 1,
    task: input.task,
    capture: {
      startedAt: input.startedAt,
      finishedAt: Date.now(),
      running: input.running,
      changedDuringExport: input.changed(),
    },
    coverage: [
      "Includes retained host events, full available history bodies, working note revisions, checkpoints, prepared operations and receipts, proposals and artifact revisions.",
      "Older tasks may predate event archiving; missing historical events cannot be reconstructed. UI event retention is not proof of a complete trace.",
      `Recovered ${journalCount} events from diagnostic history batches.`,
      "External engine private context, internal model requests and raw transport packets are not recorded. PDF files and binary image payloads are not bundled.",
      "Sections are read during the capture interval without pausing the task or reconciling writes; an active operation can change while exporting.",
      "Task text and referenced material remain in the report. Credentials are redacted; review content before sharing.",
    ],
    sections,
    events: [...events.values()].sort((a, b) => a.ts - b.ts),
    issues,
    redactions: { credentials: 0, binaryPayloads: 0 },
  };
  const redacted = redactTrace(report, input.secrets);
  const result = redacted.value as TaskTraceReport;
  result.redactions = redacted.counts;
  return result;
}
