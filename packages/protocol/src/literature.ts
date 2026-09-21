import type { LockedItemContext } from "./research";

export interface LiteratureSearch {
  query: string;
  fromYear?: number;
  toYear?: number;
  openAccess?: boolean;
  sort?: "relevance" | "date" | "citations";
  queryId?: string;
}
export interface LiteratureQuery extends LiteratureSearch {
  id: string;
  createdAt: number;
  total: number;
  cursor: string | null;
  pages: number;
}
export type LiteratureErrorCode =
  | "authentication"
  | "quota"
  | "rate_limit"
  | "network"
  | "unavailable"
  | "invalid_pdf"
  | "cancelled";
export interface LiteratureWork {
  id: string;
  openAlexIds: string[];
  doi?: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  venue?: string;
  citedBy: number;
  openAccess: boolean;
  landingUrl?: string;
  pdfUrls: string[];
  cachedPdfUrl?: string;
  queryIds: string[];
  decision: {
    selected: boolean;
    evaluated: boolean;
    reason?: string;
    actor: "agent" | "user";
    revision: number;
  };
  acquisition: {
    status: "missing" | "queued" | "downloading" | "available" | "failed";
    item?: LockedItemContext;
    attachmentKey?: string;
    error?: LiteratureErrorCode;
    message?: string;
    stage?: "existing" | "open_access" | "cache" | "browser";
  };
  /** Fulltext coverage is recorded only by an actual reader, never by search. */
  reads?: Array<{
    agent: string;
    attachmentKey: string;
    pages?: number[];
    contentVersion?: string;
    at: number;
  }>;
}
export interface LiteratureSummary {
  id: string;
  revision: number;
  candidateRevision: number;
  pool: number;
  evaluated: number;
  candidates: number;
  pendingFulltext: number;
  available: number;
  read: number;
  awaitingConfirmation: boolean;
  awaitingFulltext?: boolean;
  /** Lightweight search anchor; full queries and records live in the pool. */
  latestQuery?: Pick<
    LiteratureQuery,
    | "id"
    | "query"
    | "createdAt"
    | "total"
    | "fromYear"
    | "toYear"
    | "openAccess"
  >;
  hasCandidateChanges?: boolean;
  acquiring?: number;
}
export interface LiteraturePool {
  version: 1;
  taskId: string;
  revision: number;
  candidateRevision: number;
  confirmedRevision?: number;
  confirmedIds: string[];
  waiting?: { candidateRevision: number; requestedAt: number };
  waitingFulltext?: { ids: string[]; runId?: string; requestedAt: number };
  works: LiteratureWork[];
  queries: LiteratureQuery[];
  updatedAt: number;
}
export interface LiteraturePage {
  summary: LiteratureSummary;
  queries: LiteratureQuery[];
  items: LiteratureWork[];
  total: number;
  nextOffset: number | null;
}
export interface LiteratureConfirmation {
  candidateRevision: number;
  added: string[];
  removed: string[];
  acquire: string[];
}
export const LITERATURE_TOOL_NAMES = new Set([
  "literature_search",
  "literature_list",
  "literature_get",
  "literature_update_candidates",
  "literature_acquire",
]);
export const RESEARCH_INSTRUCTIONS = `Research discovery: literature_search fetches OpenAlex metadata into a durable pool (at most 100 per page). Pool size is fetched, deduplicated records; API total is separate. Search results appear automatically as a card in the conversation, or a capsule above the composer when that card is offscreen. Direct users to that card to review and confirm candidates; a blank task has no permanent literature search panel. Read metadata/abstracts with paginated literature_list/get, never dump the entire pool into context. Evaluating, selecting candidates, confirming sources, obtaining PDFs and reading fulltext are distinct states. Use literature_update_candidates with the current candidateRevision and a reason for each evaluation. Respect user changes; a stale revision must be re-read, never overwritten. literature_acquire requests ONE user confirmation for the exact candidate version; it cannot authorize itself. Do not import/download candidate papers via other tools to evade confirmation. Await the host instead of repeatedly asking or polling. Missing fulltext requires a targeted browser/PDF drop; metadata and abstracts are not fulltext evidence. Task sources stay fixed while executing; literature_acquire pauses the main executor at a user-confirmation boundary where the host applies the confirmed source snapshot. Previously spawned children keep their original source snapshots. Research presets restrict reading to their sources. Delegate bounded research with subagent_spawn only when useful; pass concrete goals, explicit source IDs and necessary background. Children are read-only researchers and cannot recursively delegate or change candidates. Read/wait for their compact results and preserve evidence provenance, limitations and source versions. Child evidence is not evidence you personally read. Never mark an abstract-only work as read. Acquire/collect alone does not request a reading workflow.`;
