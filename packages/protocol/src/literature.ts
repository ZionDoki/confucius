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
  abstractLookup?: {
    status: "available" | "missing" | "unavailable";
    source?: "zotero" | "openalex" | "crossref";
    checkedAt: number;
  };
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
  /** Abstract coverage among selected candidates, independent of PDF/read counts. */
  abstracts?: number;
  continuation?: LiteratureContinuation["mode"];
}
export interface LiteratureContinuation {
  candidateRevision: number;
  mode: "abstracts" | "current";
  ids: string[];
  at: number;
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
  /** User-only decision to proceed; never authorizes library writes/downloads. */
  continuation?: LiteratureContinuation;
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
export const RESEARCH_INSTRUCTIONS = `Research discovery: literature_search fetches OpenAlex metadata into a durable pool (at most 100 per page). Pool size is fetched, deduplicated records; API total is separate. All searches for one task share a single literature capsule above the composer, showing candidate count / fetched deduplicated pool size. Direct users to that capsule to review and confirm candidates; a blank task has no literature entry. Opening or closing it preserves the conversation position. Read metadata/abstracts with paginated literature_list/get, never dump the entire pool into context. literature_get makes bounded, cached attempts to fill missing abstracts from local Zotero, OpenAlex and Crossref; use it for relevant papers whose abstracts are missing before synthesizing. If no abstract can be retrieved, report that gap without inventing content or repeatedly polling. Evaluating, selecting candidates, confirming sources, obtaining PDFs and reading fulltext are distinct states. Use literature_update_candidates with the current candidateRevision and a reason for each evaluation. Respect user changes; a stale revision must be re-read, never overwritten. literature_acquire requests ONE user decision for the exact candidate version; it cannot authorize itself. Users can confirm import/download, choose to continue with abstracts without importing or downloading, or accept the current results while remaining downloads finish in the background. The returned continuation is authoritative: do not call acquisition again to override it or insist on the missing PDFs. The choice persists for the same candidate revision, including across later tool calls. Do not import/download candidate papers via other tools to evade confirmation. Await the host instead of repeatedly asking or polling. Ordinary discovery, screening and initial synthesis may proceed with abstracts; do not require fulltext unless the user explicitly needs it. When users elect to wait, the Literature capsule always lets them continue early. A targeted browser/PDF drop is optional for missing fulltext. Distinguish actually read fulltext, abstract-only evidence and metadata-only records in the answer, and state any limitations; metadata and abstracts are not fulltext evidence. Task sources stay fixed while executing; literature_acquire pauses the main executor at a user-confirmation boundary where the host applies the confirmed source snapshot. Previously spawned children keep their original source snapshots. Research presets restrict reading to their sources. Delegate bounded research with subagent_spawn only when useful; pass concrete goals, explicit source IDs and necessary background. Children are read-only researchers and cannot recursively delegate or change candidates. Read/wait for their compact results and preserve evidence provenance, limitations and source versions. Child evidence is not evidence you personally read. Never mark an abstract-only work as read. Acquire/collect alone does not request a reading workflow.`;
