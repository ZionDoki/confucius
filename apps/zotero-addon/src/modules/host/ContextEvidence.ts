import {
  contextTextSlice,
  validEvidenceLocation,
  type EvidenceLocation,
} from "@confucius/protocol";
import {
  isKnowledgeRecord,
  type HistoryStore,
  type MemoryEngine,
} from "@confucius/memory";
import { runtimeDigest } from "./RuntimeStorage";

export const memorySourceVersion = async (id: string, content: string) =>
  `m:${id}:${await runtimeDigest(content)}`;

/** Search, explicit reading and handoff share the same permission/version/offset checks. */
export async function readContextEvidence(
  stores: { history: HistoryStore; memory: MemoryEngine; sourceIds?: string[] },
  location: EvidenceLocation,
  maxTokens: number,
  explicitRead = false,
) {
  if (!validEvidenceLocation(location))
    throw new Error("Invalid evidence location");
  const [kind, id, windowOrName, itemId] = location.ref.split(":");
  const requestedOffset = location.offset ?? 0;
  const characters = Math.min(
    20000,
    (location.endOffset ?? requestedOffset + 20000) - requestedOffset,
  );
  let content: string,
    offset: number,
    nextOffset: number | null,
    sourceRefs: string[],
    sourceVersion: string;
  let revision: number | undefined;
  let delivery: "archived" | "host-provided" | "native-request" = "archived";
  let verification: "unknown" | "verified" = "unknown";
  let touch: (() => Promise<unknown>) | undefined;
  if (kind === "h") {
    const read = await stores.history.read(
      { taskId: id, windowId: windowOrName, itemId },
      requestedOffset,
      characters,
      stores.sourceIds,
    );
    ({ content, offset, nextOffset } = read);
    sourceRefs = read.item.sourceIds;
    sourceVersion = location.ref;
    delivery = read.item.delivery ?? "archived";
    verification = read.item.verification ?? "unknown";
    if (
      location.endOffset !== undefined &&
      location.endOffset > read.item.characters
    )
      throw new Error("Evidence range exceeds the archived original");
    touch = () => stores.history.touch(id);
  } else if (kind === "n") {
    const read = await stores.history.readNote(
      id,
      windowOrName,
      requestedOffset,
      characters,
      stores.sourceIds,
    );
    ({ content, offset, nextOffset, revision } = read);
    sourceRefs = read.sourceIds ?? [];
    sourceVersion = `${location.ref}:${revision}`;
    if (
      location.endOffset !== undefined &&
      location.endOffset > read.characters
    )
      throw new Error("Evidence range exceeds the saved note");
    touch = () => stores.history.touch(id);
  } else {
    if (stores.sourceIds)
      throw new Error("Memory unavailable in this source scope");
    await stores.memory.ensureLoaded();
    const record = stores.memory.get(id);
    if (!record || isKnowledgeRecord(record))
      throw new Error("Memory was cleared or is unavailable");
    sourceVersion = await memorySourceVersion(id, record.content);
    sourceRefs = record.sourceRefs ?? [];
    if (
      location.endOffset !== undefined &&
      location.endOffset > record.content.length
    )
      throw new Error("Evidence range exceeds the saved memory");
    offset = Math.min(requestedOffset, record.content.length);
    if (/[\uDC00-\uDFFF]/.test(record.content[offset] ?? "")) offset--;
    const end = Math.min(
      record.content.length,
      location.endOffset ?? offset + 20000,
    );
    content = record.content.slice(offset, end);
    nextOffset = end < record.content.length ? end : null;
    touch = () => stores.memory.read(id);
  }
  if (
    location.sourceVersion !== undefined &&
    location.sourceVersion !== sourceVersion
  )
    throw new Error(
      "Evidence version changed; search or read the current version before reusing this location",
    );
  if (
    location.endOffset !== undefined &&
    offset + content.length > location.endOffset
  )
    throw new Error(
      "Evidence boundary splits a UTF-16 character; use the returned offsets",
    );
  const slice = contextTextSlice(content, maxTokens);
  const endOffset = offset + slice.content.length;
  if (explicitRead && slice.content) await touch?.();
  return {
    ref: location.ref,
    sourceVersion,
    revision,
    offset,
    endOffset,
    page: location.page,
    section: location.section,
    content: slice.content,
    tokens: slice.tokens,
    nextOffset:
      location.endOffset !== undefined && endOffset >= location.endOffset
        ? null
        : slice.nextOffset !== null
          ? offset + slice.nextOffset
          : nextOffset,
    sourceRefs,
    archived: true,
    delivery,
    businessVerification: verification,
  };
}
