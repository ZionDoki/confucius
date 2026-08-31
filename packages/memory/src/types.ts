export const MEMORY_TYPES = [
  "preference",
  "fact",
  "project",
  "paper",
  "procedure",
  "insight",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

export interface MemoryRecord {
  /** Stable id, also the markdown filename stem (`mem_xxxx.md`). */
  id: string;
  type: MemoryType;
  /** Short human label shown in MEMORY.md and search results. */
  title: string;
  /** The memory itself, one or two sentences. */
  content: string;
  tags: string[];
  sourceSessionId?: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
  /** 0..1 extraction confidence. */
  confidence: number;
  /** Previous memory id this record replaced. */
  supersedes?: string;
  /** Prior contents, newest first. */
  history: Array<{ at: number; content: string }>;
}

export type MemoryOp =
  | {
      op: "add";
      type: MemoryType;
      title: string;
      content: string;
      tags?: string[];
      confidence?: number;
    }
  | {
      op: "update";
      id: string;
      content: string;
      title?: string;
      tags?: string[];
      confidence?: number;
    }
  | {
      op: "delete";
      id: string;
    };

export interface MemoryQuery {
  query: string;
  type?: MemoryType;
  tags?: string[];
  limit?: number;
}

export interface MemorySearchResult {
  record: MemoryRecord;
  score: number;
  lexicalScore: number;
}

export interface MemoryStats {
  total: number;
  byType: Partial<Record<MemoryType, number>>;
}
