import {
  withLockedContextFingerprint,
  type LockedContextSnapshot,
  type LockedItemContext,
  type ResearchTaskRecord,
} from "@confucius/protocol";

/** Page/selection changes are captured on Send, without rebinding on every scroll. */
export function readerAttachmentIdentity(
  context: LockedContextSnapshot,
): string {
  const reader = context.reader;
  return reader ? `${reader.libraryID}:${reader.attachmentKey}` : "";
}

/** Named articles, including readers restored without their parent item. */
export function contextArticles(
  context: LockedContextSnapshot,
): LockedItemContext[] {
  const articles = new Map(
    context.items.map((item) => [`${item.libraryID}:${item.key}`, { ...item }]),
  );
  const reader = context.reader;
  if (reader) {
    const key = reader.parentKey ?? reader.attachmentKey;
    const id = `${reader.libraryID}:${key}`;
    const item = articles.get(id);
    articles.set(id, {
      id: `item:${id}`,
      libraryID: reader.libraryID,
      key,
      title: reader.title,
      source: "reader",
      ...item,
      attachmentKey: reader.attachmentKey,
    });
  }
  return [...articles.values()];
}

/** Creation owns navigation; acquired papers remain evidence, not sidebar folders. */
export function taskArticles(task: ResearchTaskRecord): LockedItemContext[] {
  if (task.createdFrom) return task.createdFrom;
  // Older records mixed confirmed literature into their navigation sources.
  // Managed keys exclude material that was explicitly bound before acquisition.
  const acquired = new Set(task.literatureSourceKeys ?? []);
  return (
    task.articleSources ??
    contextArticles(task.run?.sources ?? task.lockedContext)
  ).filter((item) => !acquired.has(`${item.libraryID}:${item.key}`));
}

export function taskCategory(
  task: ResearchTaskRecord,
): "articles" | "research" | "unfiled" {
  if (taskArticles(task).length) return "articles";
  return task.literature?.latestQuery || task.literature?.pool
    ? "research"
    : "unfiled";
}

/** Replace only the reader's automatic source; explicit library sources survive. */
export function followReaderContext(
  locked: LockedContextSnapshot,
  live: LockedContextSnapshot,
): LockedContextSnapshot {
  const reader = live.reader;
  const current = reader
    ? contextArticles(live).filter(
        (item) =>
          item.libraryID === reader.libraryID &&
          item.key === (reader.parentKey ?? reader.attachmentKey),
      )
    : [];
  return withLockedContextFingerprint({
    ...locked,
    capturedAt: live.capturedAt,
    // Explicit sources win deduplication if the same paper was also @ mentioned.
    items: [
      ...current.map((item) => ({ ...item, source: "reader" as const })),
      ...locked.items.filter((item) => item.source !== "reader"),
    ],
    reader,
    selection: reader ? live.selection : undefined,
  });
}
