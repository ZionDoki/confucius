import {
  mergeLockedContexts,
  withLockedContextFingerprint,
  type ContextSearchItem,
  type LockedContextSnapshot,
} from "@confucius/protocol";

export interface LibraryMentionToken {
  start: number;
  end: number;
  query: string;
}

const EMAIL_LOCAL_CHARACTER = /[A-Za-z0-9._%+-]/;

/** Find the unfinished @ mention that owns the current caret position. */
export function libraryMentionTokenAtCaret(
  value: string,
  caret = value.length,
): LibraryMentionToken | null {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  const beforeCaret = value.slice(0, safeCaret);
  const start = beforeCaret.lastIndexOf("@");
  if (start < 0) return null;
  if (start > 0 && EMAIL_LOCAL_CHARACTER.test(beforeCaret[start - 1] ?? "")) {
    return null;
  }
  const rawQuery = beforeCaret.slice(start + 1);
  if (
    rawQuery.includes("\n") ||
    rawQuery.includes("@") ||
    rawQuery.length > 120
  ) {
    return null;
  }
  // A selected mention is rendered as @[Title]. Do not reopen the picker
  // while the user continues typing after that closed token.
  if (/^\[[^\]]*\](?:\s|$)/.test(rawQuery)) return null;
  return {
    start,
    end: safeCaret,
    query: rawQuery.trim(),
  };
}

export function replaceLibraryMention(
  value: string,
  token: LibraryMentionToken,
  title: string,
): { value: string; caret: number } {
  const safeTitle =
    title.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() || "Untitled";
  const replacement = `@[${safeTitle}] `;
  const suffix = value.slice(token.end).replace(/^[ \t]+/, "");
  const next = `${value.slice(0, token.start)}${replacement}${suffix}`;
  return {
    value: next,
    caret: token.start + replacement.length,
  };
}

export function mentionItemKey(
  item: Pick<ContextSearchItem, "libraryID" | "key">,
): string {
  return `${item.libraryID}:${item.key}`;
}

export function contextForMentionItems(
  items: Iterable<ContextSearchItem>,
): LockedContextSnapshot {
  return withLockedContextFingerprint({
    version: 1,
    capturedAt: Date.now(),
    items: Array.from(items, (item) => ({
      id: `item:${mentionItemKey(item)}`,
      libraryID: item.libraryID,
      key: item.key,
      title: item.title,
      source: "library" as const,
    })),
  });
}

/** Keep selected papers until their source update succeeds, independently per task. */
export class LibraryMentionSources {
  private pending = new Map<string | null, Map<string, ContextSearchItem>>();
  private updates = new Map<string, Promise<void>>();

  constructor(
    private write: (
      taskId: string,
      context: LockedContextSnapshot,
    ) => Promise<void>,
  ) {}

  add(taskId: string | null, item: ContextSearchItem): void {
    let items = this.pending.get(taskId);
    if (!items) this.pending.set(taskId, (items = new Map()));
    items.set(mentionItemKey(item), item);
  }

  has(taskId: string | null, item: ContextSearchItem): boolean {
    return this.pending.get(taskId)?.has(mentionItemKey(item)) ?? false;
  }

  context(
    base?: LockedContextSnapshot,
    taskId: string | null = null,
  ): LockedContextSnapshot | undefined {
    const items = this.pending.get(taskId);
    if (!items?.size) return base;
    const incoming = contextForMentionItems(items.values());
    return base ? mergeLockedContexts(base, incoming) : incoming;
  }

  adoptDraft(taskId: string, saved: LockedContextSnapshot): void {
    const savedKeys = new Set(saved.items.map(mentionItemKey));
    for (const item of this.pending.get(null)?.values() ?? []) {
      // A second mention may have been selected while task/new was in flight.
      if (!savedKeys.has(mentionItemKey(item))) this.add(taskId, item);
    }
    this.pending.delete(null);
  }

  flush(taskId: string): Promise<void> {
    const running = this.updates.get(taskId);
    if (running) return running;
    const update = Promise.resolve()
      .then(async () => {
        const items = this.pending.get(taskId);
        while (items?.size) {
          const batch = new Map(items);
          await this.write(taskId, contextForMentionItems(batch.values()));
          for (const [key, item] of batch) {
            if (items.get(key) === item) items.delete(key);
          }
        }
        this.pending.delete(taskId);
      })
      .finally(() => this.updates.delete(taskId));
    this.updates.set(taskId, update);
    return update;
  }
}
