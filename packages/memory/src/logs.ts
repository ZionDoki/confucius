import type { MemoryFileSystem } from "./fs";
import { MemoryRetriever } from "./retrieval";
import { tokenize } from "./tokenize";
import type { MemoryRecord } from "./types";

const SESSIONS_DIR = "sessions";
const INDEX_FILE = "LOGS.md";
const HITS_FILE = "hits.json";
const MAX_TURN_CHARS = 20_000;
const MAX_EXCERPT_CHARS = 500;
const MAX_HIT_ENTRIES = 500;

export interface ConversationLogEngineOptions {
  fs: MemoryFileSystem;
  root: string;
  now?: () => number;
  onWarn?: (message: string) => void;
}

export interface LogTurnInput {
  sessionId: string;
  title: string;
  turnId: string;
  userText: string;
  assistantText: string;
  tools?: Array<{ name: string; ok: boolean }>;
  ts?: number;
}

export interface LogSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
  turnCount: number;
}

export interface LogSearchHit {
  sessionId: string;
  title: string;
  excerpt: string;
  score: number;
  turnCount: number;
  updatedAt: number;
}

export interface LogReadResult extends LogSessionMeta {
  content: string;
  excerpt: string;
}

export interface ExcerptHit {
  hash: string;
  sessionId: string;
  excerpt: string;
  count: number;
  lastQuery: string;
  lastAccessedAt: number;
  promotedId?: string;
}

interface HitStore {
  excerpts: Record<string, Omit<ExcerptHit, "hash">>;
}

interface SessionRecord extends LogSessionMeta {
  body: string;
}

/**
 * Append-only conversation transcripts as searchable markdown files.
 * Compaction of the in-context working set never deletes these files —
 * they are the episodic record the agent can retrieve later.
 *
 * Layout under `<Zotero data>/confucius/logs/`:
 *
 *     LOGS.md              regenerated index
 *     hits.json            excerpt hit counts for promotion
 *     sessions/ses_xxx.md  one file per session
 */
export class ConversationLogEngine {
  private readonly retriever = new MemoryRetriever();
  private readonly now: () => number;
  private readonly onWarn?: (message: string) => void;
  private sessions = new Map<string, SessionRecord>();
  private hits: HitStore = { excerpts: {} };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private hitsDirty = false;

  constructor(private readonly options: ConversationLogEngineOptions) {
    this.now = options.now ?? Date.now;
    this.onWarn = options.onWarn;
  }

  private get sessionsDir(): string {
    return joinPath(this.options.root, SESSIONS_DIR);
  }

  private get indexPath(): string {
    return joinPath(this.options.root, INDEX_FILE);
  }

  private get hitsPath(): string {
    return joinPath(this.options.root, HITS_FILE);
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.loadNow();
      this.loaded = true;
    }
  }

  private async loadNow(): Promise<void> {
    await this.options.fs.makeDirectory(this.sessionsDir);
    const files = await this.options.fs.listFiles(this.sessionsDir);
    const loaded = new Map<string, SessionRecord>();
    for (const path of files) {
      if (!path.endsWith(".md")) {
        continue;
      }
      try {
        const text = await this.options.fs.readFile(path);
        const record = parseLogFile(fileName(path), text);
        if (record) {
          loaded.set(record.id, record);
        }
      } catch (error) {
        this.onWarn?.(`skip unreadable log ${path}: ${String(error)}`);
      }
    }
    this.sessions = loaded;
    try {
      const raw = await this.options.fs.readFile(this.hitsPath);
      const parsed = JSON.parse(raw) as HitStore;
      this.hits = {
        excerpts:
          parsed && typeof parsed.excerpts === "object" && parsed.excerpts
            ? parsed.excerpts
            : {},
      };
    } catch {
      this.hits = { excerpts: {} };
    }
    this.reindex();
  }

  private reindex(): void {
    this.retriever.index([...this.sessions.values()].map(toSyntheticMemory));
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(work);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async appendTurn(input: LogTurnInput): Promise<LogSessionMeta> {
    await this.ensureLoaded();
    const timestamp = input.ts ?? this.now();
    const existing = this.sessions.get(input.sessionId);
    const section = formatTurnSection(input, timestamp);
    const next: SessionRecord = existing
      ? {
          ...existing,
          title: input.title.trim() || existing.title,
          updatedAt: timestamp,
          turnCount: existing.turnCount + 1,
          body: existing.body
            ? `${existing.body.trim()}\n\n${section}`
            : section,
        }
      : {
          id: input.sessionId,
          title: input.title.trim() || input.sessionId,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastAccessedAt: timestamp,
          accessCount: 0,
          turnCount: 1,
          body: section,
        };
    this.sessions.set(next.id, next);
    this.reindex();
    await this.serialize(async () => {
      await this.options.fs.makeDirectory(this.sessionsDir);
      await this.options.fs.writeFile(
        this.sessionPath(next.id),
        serializeLog(next),
      );
      await this.rebuildIndex();
    });
    return toMeta(next);
  }

  async list(limit = 50): Promise<LogSessionMeta[]> {
    await this.ensureLoaded();
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, limit))
      .map(toMeta);
  }

  async search(query: string, limit = 6): Promise<LogSearchHit[]> {
    await this.ensureLoaded();
    const results = this.retriever.search(
      { query, limit: Math.max(1, limit) },
      this.now(),
    );
    return results.map((hit) => {
      const session = this.sessions.get(hit.record.id);
      const body = session?.body ?? hit.record.content;
      return {
        sessionId: hit.record.id,
        title: hit.record.title,
        excerpt: bestExcerpt(body, query, MAX_EXCERPT_CHARS),
        score: hit.score,
        turnCount: session?.turnCount ?? 0,
        updatedAt: session?.updatedAt ?? hit.record.updatedAt,
      };
    });
  }

  async read(
    sessionId: string,
    options: { query?: string; maxChars?: number } = {},
  ): Promise<LogReadResult | null> {
    await this.ensureLoaded();
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    const maxChars = Math.max(200, options.maxChars ?? 8_000);
    const query = (options.query ?? "").trim();
    return {
      ...toMeta(session),
      content: clip(session.body, maxChars),
      excerpt: bestExcerpt(session.body, query, MAX_EXCERPT_CHARS),
    };
  }

  get(sessionId: string): LogSessionMeta | undefined {
    const session = this.sessions.get(sessionId);
    return session ? toMeta(session) : undefined;
  }

  /** Session-level retrieval without promoting an excerpt. */
  async touch(sessionId: string, now?: number): Promise<void> {
    await this.ensureLoaded();
    this.touchSession(sessionId, now ?? this.now());
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    await this.serialize(() =>
      this.options.fs.writeFile(
        this.sessionPath(session.id),
        serializeLog(session),
      ),
    );
  }

  /**
   * Record retrieval hits for promotion. One increment per unique excerpt
   * (and per session) in this call.
   */
  async recordHits(
    hits: LogSearchHit[],
    query: string,
    now?: number,
  ): Promise<ExcerptHit[]> {
    await this.ensureLoaded();
    const timestamp = now ?? this.now();
    const seenSessions = new Set<string>();
    const seenHashes = new Set<string>();
    const out: ExcerptHit[] = [];
    const dirtySessions: SessionRecord[] = [];
    for (const hit of hits) {
      const excerpt = hit.excerpt.trim();
      if (!hit.sessionId || !excerpt) {
        continue;
      }
      const hash = excerptKey(hit.sessionId, excerpt);
      if (seenHashes.has(hash)) {
        continue;
      }
      seenHashes.add(hash);
      if (!seenSessions.has(hit.sessionId)) {
        seenSessions.add(hit.sessionId);
        const session = this.touchSession(hit.sessionId, timestamp);
        if (session) {
          dirtySessions.push(session);
        }
      }
      const existing = this.hits.excerpts[hash] ?? {
        sessionId: hit.sessionId,
        excerpt,
        count: 0,
        lastQuery: query,
        lastAccessedAt: timestamp,
      };
      existing.count += 1;
      existing.lastQuery = query;
      existing.lastAccessedAt = timestamp;
      if (excerpt.length > existing.excerpt.length) {
        existing.excerpt = excerpt;
      }
      this.hits.excerpts[hash] = existing;
      this.hitsDirty = true;
      out.push({ hash, ...existing });
    }
    this.pruneHits();
    await this.serialize(async () => {
      for (const session of dirtySessions) {
        await this.options.fs.writeFile(
          this.sessionPath(session.id),
          serializeLog(session),
        );
      }
      if (this.hitsDirty) {
        await this.options.fs.writeFile(
          this.hitsPath,
          JSON.stringify(this.hits, null, 2) + "\n",
        );
        this.hitsDirty = false;
      }
    });
    return out;
  }

  async markPromoted(hash: string, memoryId: string): Promise<void> {
    await this.ensureLoaded();
    const existing = this.hits.excerpts[hash];
    if (!existing) {
      return;
    }
    existing.promotedId = memoryId;
    this.hitsDirty = true;
    await this.serialize(async () => {
      await this.options.fs.writeFile(
        this.hitsPath,
        JSON.stringify(this.hits, null, 2) + "\n",
      );
      this.hitsDirty = false;
    });
  }

  getExcerpt(hash: string): ExcerptHit | undefined {
    const existing = this.hits.excerpts[hash];
    return existing ? { hash, ...existing } : undefined;
  }

  stats(): { sessions: number; turns: number } {
    let turns = 0;
    for (const session of this.sessions.values()) {
      turns += session.turnCount;
    }
    return { sessions: this.sessions.size, turns };
  }

  private touchSession(
    sessionId: string,
    timestamp: number,
  ): SessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.lastAccessedAt = timestamp;
    session.accessCount += 1;
    return session;
  }

  private pruneHits(): void {
    const entries = Object.entries(this.hits.excerpts);
    if (entries.length <= MAX_HIT_ENTRIES) {
      return;
    }
    entries.sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
    const drop = entries.length - MAX_HIT_ENTRIES;
    for (const [hash] of entries.slice(0, drop)) {
      delete this.hits.excerpts[hash];
    }
  }

  private async rebuildIndex(): Promise<void> {
    const records = [...this.sessions.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const lines = [
      "# Confucius conversation logs",
      "",
      `${records.length} sessions. Files in \`${SESSIONS_DIR}/\` are the source of truth;`,
      "compaction of the in-context working set never deletes these files.",
      "",
    ];
    if (records.length === 0) {
      lines.push("_No conversation logs yet._");
    }
    for (const record of records) {
      const date = new Date(record.updatedAt).toISOString().slice(0, 10);
      lines.push(
        `- **${record.title}** \`${record.id}\` — ${record.turnCount} turns, accessed ${record.accessCount}× _(${date})_`,
      );
    }
    lines.push("");
    await this.options.fs.makeDirectory(this.options.root);
    await this.options.fs.writeFile(this.indexPath, lines.join("\n"));
  }

  private sessionPath(id: string): string {
    return joinPath(this.sessionsDir, `${id}.md`);
  }
}

export function excerptKey(sessionId: string, excerpt: string): string {
  const normalized = excerpt.replace(/\s+/g, " ").trim().slice(0, 240);
  const input = `${sessionId}:${normalized}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function bestExcerpt(
  body: string,
  query: string,
  maxChars = MAX_EXCERPT_CHARS,
): string {
  const sections = body.split(/\n(?=## )/);
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || sections.length === 0) {
    return clip(body.trim(), maxChars);
  }
  let best = sections[0];
  let bestScore = -1;
  for (const section of sections) {
    const tokens = new Set(tokenize(section));
    let score = 0;
    for (const token of queryTokens) {
      if (tokens.has(token)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = section;
    }
  }
  return clip(stripTurnHeading(best).trim(), maxChars);
}

function stripTurnHeading(section: string): string {
  return section.replace(/^##\s+[^\n]+\n?/, "");
}

function formatTurnSection(input: LogTurnInput, timestamp: number): string {
  const when = new Date(timestamp).toISOString();
  const lines = [`## ${when} ${input.turnId}`, ""];
  lines.push(`**user:** ${clip(input.userText.trim(), MAX_TURN_CHARS)}`);
  lines.push("");
  if (input.assistantText.trim()) {
    lines.push(
      `**assistant:** ${clip(input.assistantText.trim(), MAX_TURN_CHARS)}`,
    );
    lines.push("");
  }
  for (const tool of input.tools ?? []) {
    lines.push(`**tool ${tool.name}:** ${tool.ok ? "ok" : "error"}`);
  }
  return lines.join("\n").trim();
}

function serializeLog(record: SessionRecord): string {
  const lines = [
    "---",
    `id: ${record.id}`,
    `title: ${record.title.replace(/\n/g, " ").trim()}`,
    `created: ${record.createdAt}`,
    `updated: ${record.updatedAt}`,
    `last-accessed: ${record.lastAccessedAt}`,
    `access-count: ${record.accessCount}`,
    `turn-count: ${record.turnCount}`,
    "---",
    "",
    record.body.trim(),
    "",
  ];
  return lines.join("\n");
}

function parseLogFile(filename: string, text: string): SessionRecord | null {
  if (!text.startsWith("---")) {
    return null;
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) {
    return null;
  }
  const frontmatter = text.slice(4, end);
  const body = text.slice(end + 4).trim();
  const map = new Map<string, string>();
  for (const line of frontmatter.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    map.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const id = map.get("id") ?? filename.replace(/\.md$/, "");
  const updatedAt = Number(map.get("updated")) || 0;
  return {
    id,
    title: map.get("title") || id,
    createdAt: Number(map.get("created")) || updatedAt,
    updatedAt,
    lastAccessedAt: Number(map.get("last-accessed")) || updatedAt,
    accessCount: Number(map.get("access-count")) || 0,
    turnCount: Number(map.get("turn-count")) || 0,
    body,
  };
}

function toSyntheticMemory(record: SessionRecord): MemoryRecord {
  return {
    id: record.id,
    type: "note",
    title: record.title,
    content: record.body,
    tags: [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastAccessedAt: record.lastAccessedAt,
    accessCount: record.accessCount,
    confidence: 0.5,
    history: [],
  };
}

function toMeta(record: SessionRecord): LogSessionMeta {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastAccessedAt: record.lastAccessedAt,
    accessCount: record.accessCount,
    turnCount: record.turnCount,
  };
}

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n…`;
}

function joinPath(base: string, rest: string): string {
  return base.endsWith("/") ? `${base}${rest}` : `${base}/${rest}`;
}

function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}
