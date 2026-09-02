import type { MemoryEngine } from "./engine";
import type { MemoryRecord, MemoryType } from "./types";

export const KNOWLEDGE_BASE_TAG = "confucius:knowledge-base";
export const KNOWLEDGE_ENTRY_TAG = "confucius:knowledge-entry";
const KNOWLEDGE_BASE_PREFIX = "kb:";
const KNOWLEDGE_KIND_PREFIX = "kind:";
const ZOTERO_SOURCE_PREFIX = "zotero:";

export const KNOWLEDGE_ENTRY_TYPES = [
  "paper",
  "note",
  "insight",
  "method",
  "discussion",
  "mindmap",
] as const;

export type KnowledgeEntryType = (typeof KNOWLEDGE_ENTRY_TYPES)[number];

export interface KnowledgeEntrySource {
  libraryID: number;
  key: string;
}

export interface KnowledgeEntry {
  id: string;
  knowledgeBaseId: string;
  kind: KnowledgeEntryType;
  title: string;
  content: string;
  tags: string[];
  source?: KnowledgeEntrySource;
  sourceSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeBase {
  id: string;
  title: string;
  description: string;
  tags: string[];
  entryCount: number;
  counts: Partial<Record<KnowledgeEntryType, number>>;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeBaseDetail extends KnowledgeBase {
  entries: KnowledgeEntry[];
}

export function isKnowledgeEntryType(
  value: unknown,
): value is KnowledgeEntryType {
  return (
    typeof value === "string" &&
    (KNOWLEDGE_ENTRY_TYPES as readonly string[]).includes(value)
  );
}

export function knowledgeBaseTag(id: string): string {
  return `${KNOWLEDGE_BASE_PREFIX}${id.trim()}`;
}

export function knowledgeKindTag(kind: KnowledgeEntryType): string {
  return `${KNOWLEDGE_KIND_PREFIX}${kind}`;
}

/**
 * A focused facade over MemoryEngine. Knowledge bases remain ordinary,
 * human-readable memory markdown files while callers never need to know the
 * internal relationship tags.
 */
export class KnowledgeBaseService {
  constructor(private readonly engine: MemoryEngine) {}

  async list(
    options: { query?: string; limit?: number } = {},
  ): Promise<KnowledgeBase[]> {
    const records = await this.engine.list({
      type: "project",
      tags: [KNOWLEDGE_BASE_TAG],
      limit: Math.max(1, options.limit ?? 100),
    });
    const allEntries = await this.engine.list({
      tags: [KNOWLEDGE_ENTRY_TAG],
      limit: 10_000,
    });
    const query = (options.query ?? "").trim().toLowerCase();
    return records
      .filter((record) => {
        if (!query) return true;
        return `${record.title}\n${record.content}\n${customTags(record).join(" ")}`
          .toLowerCase()
          .includes(query);
      })
      .map((record) => toKnowledgeBase(record, allEntries));
  }

  async get(
    id: string,
    options: { kind?: KnowledgeEntryType; limit?: number } = {},
  ): Promise<KnowledgeBaseDetail | null> {
    await this.engine.ensureLoaded();
    const record = this.engine.get(id);
    if (!record || !isKnowledgeBaseRecord(record)) {
      return null;
    }
    const entryRecords = await this.engine.list({
      type: options.kind ? memoryTypeForKind(options.kind) : undefined,
      tags: [KNOWLEDGE_ENTRY_TAG, knowledgeBaseTag(id)],
      tagsMode: "all",
      limit: Math.max(1, options.limit ?? 1_000),
    });
    const entries = entryRecords
      .map(toKnowledgeEntry)
      .filter((entry): entry is KnowledgeEntry => Boolean(entry))
      .filter((entry) => !options.kind || entry.kind === options.kind);
    return { ...toKnowledgeBase(record, entryRecords), entries };
  }

  async create(input: {
    title: string;
    description?: string;
    tags?: string[];
    sourceSessionId?: string;
  }): Promise<KnowledgeBase> {
    const title = requiredText(input.title, "Knowledge base title");
    const record = await this.engine.save({
      type: "project",
      title,
      content: (input.description ?? "").trim(),
      tags: mergeTags([KNOWLEDGE_BASE_TAG], input.tags),
      sourceSessionId: input.sourceSessionId,
    });
    const updated = await this.engine.update({
      id: record.id,
      tags: mergeTags(
        [KNOWLEDGE_BASE_TAG, knowledgeBaseTag(record.id)],
        input.tags,
      ),
    });
    return toKnowledgeBase(updated ?? record, []);
  }

  async update(input: {
    id: string;
    title?: string;
    description?: string;
    tags?: string[];
  }): Promise<KnowledgeBase | null> {
    await this.engine.ensureLoaded();
    const existing = this.engine.get(input.id);
    if (!existing || !isKnowledgeBaseRecord(existing)) {
      return null;
    }
    const updated = await this.engine.update({
      id: input.id,
      title:
        input.title === undefined
          ? undefined
          : requiredText(input.title, "Knowledge base title"),
      content:
        input.description === undefined ? undefined : input.description.trim(),
      tags:
        input.tags === undefined
          ? undefined
          : mergeTags(
              [KNOWLEDGE_BASE_TAG, knowledgeBaseTag(input.id)],
              input.tags,
            ),
    });
    if (!updated) return null;
    const entries = await this.engine.list({
      tags: [KNOWLEDGE_ENTRY_TAG, knowledgeBaseTag(input.id)],
      tagsMode: "all",
      limit: 10_000,
    });
    return toKnowledgeBase(updated, entries);
  }

  async delete(
    id: string,
  ): Promise<{ removed: boolean; entriesRemoved: number }> {
    const detail = await this.get(id, { limit: 10_000 });
    if (!detail) return { removed: false, entriesRemoved: 0 };
    let entriesRemoved = 0;
    for (const entry of detail.entries) {
      if (await this.engine.delete(entry.id)) entriesRemoved += 1;
    }
    return { removed: await this.engine.delete(id), entriesRemoved };
  }

  async search(input: {
    query: string;
    knowledgeBaseId?: string;
    kind?: KnowledgeEntryType;
    limit?: number;
  }): Promise<Array<{ entry: KnowledgeEntry; score: number }>> {
    const query = requiredText(input.query, "Search query");
    const filterTags = [KNOWLEDGE_ENTRY_TAG];
    if (input.knowledgeBaseId) {
      const base = await this.get(input.knowledgeBaseId, { limit: 1 });
      if (!base) return [];
      filterTags.push(knowledgeBaseTag(input.knowledgeBaseId));
    }
    const results = await this.engine.search({
      query,
      type: input.kind ? memoryTypeForKind(input.kind) : undefined,
      filterTags,
      limit: Math.max(1, input.limit ?? 20),
    });
    return results.flatMap((hit) => {
      const entry = toKnowledgeEntry(hit.record);
      if (!entry || (input.kind && entry.kind !== input.kind)) return [];
      return [{ entry, score: hit.score }];
    });
  }

  async saveEntry(input: {
    id?: string;
    knowledgeBaseId: string;
    kind: KnowledgeEntryType;
    title: string;
    content: string;
    tags?: string[];
    source?: KnowledgeEntrySource;
    clearSource?: boolean;
    sourceSessionId?: string;
  }): Promise<KnowledgeEntry | null> {
    const base = await this.get(input.knowledgeBaseId, { limit: 1 });
    if (!base) return null;
    const title = requiredText(input.title, "Entry title");
    const content = requiredText(input.content, "Entry content");
    const systemTags = [
      KNOWLEDGE_ENTRY_TAG,
      knowledgeBaseTag(input.knowledgeBaseId),
      knowledgeKindTag(input.kind),
    ];
    if (input.source) {
      const libraryID = Math.trunc(Number(input.source.libraryID));
      const key = String(input.source.key ?? "").trim();
      if (libraryID > 0 && key) {
        systemTags.push(`${ZOTERO_SOURCE_PREFIX}${libraryID}:${key}`);
      }
    }
    if (input.id) {
      await this.engine.ensureLoaded();
      const existing = this.engine.get(input.id);
      const entry = existing ? toKnowledgeEntry(existing) : null;
      if (!entry || entry.knowledgeBaseId !== input.knowledgeBaseId) {
        return null;
      }
      if (!input.source && entry.source && !input.clearSource) {
        systemTags.push(
          `${ZOTERO_SOURCE_PREFIX}${entry.source.libraryID}:${entry.source.key}`,
        );
      }
      const updated = await this.engine.update({
        id: input.id,
        type: memoryTypeForKind(input.kind),
        title,
        content,
        tags: mergeTags(systemTags, input.tags),
      });
      return updated ? toKnowledgeEntry(updated) : null;
    }
    const record = await this.engine.save({
      type: memoryTypeForKind(input.kind),
      title,
      content,
      tags: mergeTags(systemTags, input.tags),
      sourceSessionId: input.sourceSessionId,
    });
    return toKnowledgeEntry(record);
  }

  async deleteEntry(knowledgeBaseId: string, id: string): Promise<boolean> {
    await this.engine.ensureLoaded();
    const existing = this.engine.get(id);
    const entry = existing ? toKnowledgeEntry(existing) : null;
    if (!entry || entry.knowledgeBaseId !== knowledgeBaseId) return false;
    return this.engine.delete(id);
  }
}

function isKnowledgeBaseRecord(record: MemoryRecord): boolean {
  return record.type === "project" && hasTag(record, KNOWLEDGE_BASE_TAG);
}

function toKnowledgeBase(
  record: MemoryRecord,
  entryRecords: MemoryRecord[],
): KnowledgeBase {
  const entries = entryRecords
    .filter((entry) => hasTag(entry, knowledgeBaseTag(record.id)))
    .map(toKnowledgeEntry)
    .filter((entry): entry is KnowledgeEntry => Boolean(entry));
  const counts: Partial<Record<KnowledgeEntryType, number>> = {};
  for (const entry of entries) {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  }
  return {
    id: record.id,
    title: record.title,
    description: record.content,
    tags: customTags(record),
    entryCount: entries.length,
    counts,
    createdAt: record.createdAt,
    updatedAt: Math.max(
      record.updatedAt,
      ...entries.map((entry) => entry.updatedAt),
    ),
  };
}

function toKnowledgeEntry(record: MemoryRecord): KnowledgeEntry | null {
  if (!hasTag(record, KNOWLEDGE_ENTRY_TAG)) return null;
  const baseTag = record.tags.find((tag) =>
    tag.toLowerCase().startsWith(KNOWLEDGE_BASE_PREFIX),
  );
  const kindTag = record.tags.find((tag) =>
    tag.toLowerCase().startsWith(KNOWLEDGE_KIND_PREFIX),
  );
  const kind = kindTag?.slice(KNOWLEDGE_KIND_PREFIX.length).toLowerCase();
  if (!baseTag || !isKnowledgeEntryType(kind)) return null;
  const sourceTag = record.tags.find((tag) =>
    tag.toLowerCase().startsWith(ZOTERO_SOURCE_PREFIX),
  );
  const source = parseSource(sourceTag);
  return {
    id: record.id,
    knowledgeBaseId: baseTag.slice(KNOWLEDGE_BASE_PREFIX.length),
    kind,
    title: record.title,
    content: record.content,
    tags: customTags(record),
    source,
    sourceSessionId: record.sourceSessionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function parseSource(
  tag: string | undefined,
): KnowledgeEntrySource | undefined {
  if (!tag) return undefined;
  const match = tag.match(/^zotero:(\d+):(.+)$/i);
  if (!match) return undefined;
  return { libraryID: Number(match[1]), key: match[2] };
}

function customTags(record: MemoryRecord): string[] {
  return record.tags.filter(
    (tag) =>
      tag.toLowerCase() !== KNOWLEDGE_BASE_TAG &&
      tag.toLowerCase() !== KNOWLEDGE_ENTRY_TAG &&
      !tag.toLowerCase().startsWith(KNOWLEDGE_BASE_PREFIX) &&
      !tag.toLowerCase().startsWith(KNOWLEDGE_KIND_PREFIX) &&
      !tag.toLowerCase().startsWith(ZOTERO_SOURCE_PREFIX),
  );
}

function mergeTags(
  required: string[],
  optional: string[] | undefined,
): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...required, ...(optional ?? [])]) {
    const tag = String(raw).trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key) || isReservedCustomTag(tag, required)) continue;
    seen.add(key);
    output.push(tag);
  }
  return output;
}

function isReservedCustomTag(tag: string, required: string[]): boolean {
  const lower = tag.toLowerCase();
  if (required.some((entry) => entry.toLowerCase() === lower)) return false;
  return (
    lower === KNOWLEDGE_BASE_TAG ||
    lower === KNOWLEDGE_ENTRY_TAG ||
    lower.startsWith(KNOWLEDGE_BASE_PREFIX) ||
    lower.startsWith(KNOWLEDGE_KIND_PREFIX) ||
    lower.startsWith(ZOTERO_SOURCE_PREFIX)
  );
}

function hasTag(record: MemoryRecord, tag: string): boolean {
  const expected = tag.toLowerCase();
  return record.tags.some((own) => own.toLowerCase() === expected);
}

function memoryTypeForKind(kind: KnowledgeEntryType): MemoryType {
  return kind;
}

function requiredText(value: string, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}
