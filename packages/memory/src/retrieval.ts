import type {
  MemoryQuery,
  MemoryRecord,
  MemorySearchResult,
  MemoryType,
} from "./types";
import { termFrequency, tokenize } from "./tokenize";

/**
 * Hybrid ranking without embeddings: BM25 lexical score fused with recency
 * decay, access reinforcement, and extraction confidence, plus exact tag
 * boosts. Deterministic and fully offline, which is the point — the corpus
 * is small enough (personal research memory) that lexical recall is strong.
 */

const K1 = 1.5;
const B = 0.75;
const HALF_LIFE_DAYS = 30;
const MAX_ACCESS_COUNT = 10;

const WEIGHTS = {
  lexical: 0.6,
  recency: 0.15,
  reinforcement: 0.1,
  confidence: 0.15,
} as const;

const TAG_BOOST = 0.2;

interface CorpusDoc {
  record: MemoryRecord;
  tf: Map<string, number>;
  length: number;
}

export class MemoryRetriever {
  private docs: CorpusDoc[] = [];
  private df = new Map<string, number>();

  index(records: MemoryRecord[]): void {
    this.docs = records.map((record) => {
      const tokens = tokenize(
        `${record.title} ${record.content} ${record.tags.join(" ")}`,
      );
      return { record, tf: termFrequency(tokens), length: tokens.length };
    });
    this.df = new Map();
    for (const doc of this.docs) {
      for (const term of doc.tf.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
  }

  get size(): number {
    return this.docs.length;
  }

  search(
    query: MemoryQuery,
    now: number,
    recordsChanged?: () => void,
  ): MemorySearchResult[] {
    const queryTokens = tokenize(
      `${query.query} ${(query.tags ?? []).join(" ")}`,
    );
    const scored: MemorySearchResult[] = [];
    for (const doc of this.docs) {
      if (query.type && doc.record.type !== query.type) {
        continue;
      }
      if (
        query.filterTags &&
        query.filterTags.length > 0 &&
        !hasAllTags(doc.record, query.filterTags)
      ) {
        continue;
      }
      if (
        query.tags &&
        query.tags.length > 0 &&
        !query.tags.some((tag) =>
          doc.record.tags.some(
            (own) => own.toLowerCase() === tag.toLowerCase(),
          ),
        )
      ) {
        continue;
      }
      const lexical = this.bm25(doc, queryTokens);
      if (lexical <= 0 && !hasTagOverlap(doc.record, query.tags ?? [])) {
        continue;
      }
      const recency = recencyBoost(
        doc.record.lastAccessedAt || doc.record.updatedAt,
        now,
      );
      const reinforcement =
        Math.log1p(doc.record.accessCount) / Math.log1p(MAX_ACCESS_COUNT);
      const confidence = doc.record.confidence;
      const score =
        lexical * WEIGHTS.lexical +
        recency * WEIGHTS.recency +
        reinforcement * WEIGHTS.reinforcement +
        confidence * WEIGHTS.confidence +
        (hasTagOverlap(doc.record, query.tags ?? []) ? TAG_BOOST : 0);
      scored.push({
        record: doc.record,
        score: round3(score),
        lexicalScore: round3(lexical),
      });
    }
    scored.sort(
      (a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt,
    );
    const limited = scored.slice(0, Math.max(1, query.limit ?? 6));
    if (recordsChanged) {
      recordsChanged();
    }
    return limited;
  }

  private bm25(doc: CorpusDoc, queryTokens: string[]): number {
    if (queryTokens.length === 0 || this.docs.length === 0) {
      return 0;
    }
    const avgLength =
      this.docs.reduce((sum, entry) => sum + entry.length, 0) /
      this.docs.length;
    const queryTf = termFrequency(queryTokens);
    let score = 0;
    for (const [term, queryCount] of queryTf) {
      const frequency = doc.tf.get(term) ?? 0;
      if (frequency === 0) {
        continue;
      }
      const docFrequency = this.df.get(term) ?? 0;
      const idf = Math.log(
        1 + (this.docs.length - docFrequency + 0.5) / (docFrequency + 0.5),
      );
      const denominator =
        frequency + K1 * (1 - B + (B * doc.length) / avgLength);
      score += idf * ((frequency * (K1 + 1)) / denominator) * queryCount;
    }
    return score;
  }
}

function hasTagOverlap(record: MemoryRecord, tags: string[]): boolean {
  if (tags.length === 0) {
    return false;
  }
  return tags.some((tag) =>
    record.tags.some((own) => own.toLowerCase() === tag.toLowerCase()),
  );
}

function hasAllTags(record: MemoryRecord, tags: string[]): boolean {
  const own = new Set(record.tags.map((tag) => tag.toLowerCase()));
  return tags.every((tag) => own.has(tag.toLowerCase()));
}

function recencyBoost(timestamp: number, now: number): number {
  if (!timestamp || timestamp >= now) {
    return 1;
  }
  const ageDays = (now - timestamp) / 86_400_000;
  return Math.exp(-ageDays / HALF_LIFE_DAYS);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function memoryTypesOf(
  records: MemoryRecord[],
): Partial<Record<MemoryType, number>> {
  const byType: Partial<Record<MemoryType, number>> = {};
  for (const record of records) {
    byType[record.type] = (byType[record.type] ?? 0) + 1;
  }
  return byType;
}
