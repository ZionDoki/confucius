import type { CollectionRef, ItemRef } from "./item";
import type { SessionContext } from "./session";

export const AGENT_BACKENDS = ["native", "codex", "kimi"] as const;

export type AgentBackendKind = (typeof AGENT_BACKENDS)[number];

export type TaskStatus =
  | "ready"
  | "running"
  | "awaiting_approval"
  | "interrupted"
  | "completed"
  | "failed";

export type MemoryConsent = "off" | "review" | "auto";

export type CapabilityProfile = "zotero_only" | "workspace";

export interface LockedItemContext extends ItemRef {
  id: string;
  title: string;
  source: "library" | "reader" | "legacy";
  attachmentKey?: string;
}

export interface LockedCollectionContext extends CollectionRef {
  id: string;
  name: string;
}

export interface LockedSavedSearchContext {
  id: string;
  libraryID: number;
  key: string;
  name: string;
}

export interface LockedReaderContext {
  id: string;
  libraryID: number;
  attachmentKey: string;
  parentKey: string | null;
  title: string;
  pageLabel: string | null;
  pageIndex: number | null;
}

export interface LockedSelectionContext {
  id: string;
  text: string;
  pageLabel: string | null;
  pageIndex: number | null;
  attachmentKey?: string;
}

/** A task-owned snapshot. Live Zotero selection is never read implicitly. */
export interface LockedContextSnapshot {
  version: 1;
  capturedAt: number;
  fingerprint: string;
  items: LockedItemContext[];
  collection?: LockedCollectionContext;
  savedSearch?: LockedSavedSearchContext;
  reader?: LockedReaderContext;
  selection?: LockedSelectionContext;
}

export interface RecoverableTurn {
  turnId: string;
  userText: string;
  checkpointAt: number;
  iteration: number;
  externalTurnId?: string;
  unknownToolCallIds: string[];
}

export interface RuntimeStatus {
  backend: AgentBackendKind;
  state: "ready" | "unavailable" | "auth_required" | "error";
  version?: string;
  message?: string;
  executable?: string;
  checkedAt: number;
}

export type ArtifactKind =
  | "deep_read"
  | "evidence_audit"
  | "literature_map"
  | "triage_table"
  | "report"
  | "note_draft"
  | "annotation_set"
  | "collection_diff"
  | "citation_list";

export interface Citation {
  id?: string;
  itemLibraryID: number;
  itemKey: string;
  page?: number;
  section?: string;
  quote?: string;
}

export interface MarkdownArtifactBody {
  type: "markdown";
  markdown: string;
}

export interface EvidenceAuditArtifactBody {
  type: "evidence_audit";
  claims: Array<{
    claim: string;
    verdict: "supported" | "mixed" | "unsupported" | "unclear";
    rationale: string;
    citationIds: string[];
  }>;
}

export interface LiteratureMapArtifactBody {
  type: "literature_map";
  nodes: Array<{
    id: string;
    label: string;
    summary?: string;
    item?: ItemRef;
  }>;
  edges: Array<{
    source: string;
    target: string;
    relation: string;
    citationIds?: string[];
  }>;
}

export interface TriageTableArtifactBody {
  type: "triage_table";
  rows: Array<{
    item: ItemRef;
    title: string;
    decision: "keep" | "review" | "exclude";
    reason: string;
    tags?: string[];
  }>;
}

export interface AnnotationSetArtifactBody {
  type: "annotation_set";
  item: ItemRef;
  highlights: Array<{
    page: number;
    quote: string;
    comment?: string;
    color?: string;
  }>;
}

export interface CollectionDiffArtifactBody {
  type: "collection_diff";
  collection?: CollectionRef;
  name?: string;
  operations: Array<{
    op: "create" | "add" | "remove" | "tag_add" | "tag_remove";
    item?: ItemRef;
    value?: string;
  }>;
}

export interface CitationListArtifactBody {
  type: "citation_list";
  style?: string;
  entries: Array<{
    citationId: string;
    rendered: string;
  }>;
}

export type ArtifactBody =
  | MarkdownArtifactBody
  | EvidenceAuditArtifactBody
  | LiteratureMapArtifactBody
  | TriageTableArtifactBody
  | AnnotationSetArtifactBody
  | CollectionDiffArtifactBody
  | CitationListArtifactBody;

export type ArtifactStatus = "draft" | "ready" | "committed";

export interface ArtifactWriteback {
  state: "none" | "pending" | "committed" | "failed";
  target:
    | "zotero_note"
    | "zotero_annotations"
    | "zotero_collection"
    | "zotero_tags"
    | "knowledge_base";
  targetRef?: string;
  revision?: number;
  committedAt?: number;
  error?: string;
}

export interface ArtifactRevision {
  revision: number;
  body: ArtifactBody;
  citations: Citation[];
  sourceContextIds: string[];
  createdAt: number;
  backend: AgentBackendKind;
}

export interface ArtifactRecord {
  id: string;
  /** Session and task are one-to-one in schema v2. */
  sessionId: string;
  taskId: string;
  kind: ArtifactKind;
  title: string;
  body: ArtifactBody;
  status: ArtifactStatus;
  revision: number;
  citations: Citation[];
  sourceContextIds: string[];
  revisions: ArtifactRevision[];
  writeback?: ArtifactWriteback;
  createdAt: number;
  updatedAt: number;
}

/** Lightweight event/index view; artifact bodies stay in ArtifactStore. */
export type ArtifactSummary = Pick<
  ArtifactRecord,
  | "id"
  | "sessionId"
  | "taskId"
  | "kind"
  | "title"
  | "status"
  | "revision"
  | "writeback"
  | "createdAt"
  | "updatedAt"
>;

export interface ArtifactUpsertInput {
  id?: string;
  taskId: string;
  kind: ArtifactKind;
  title: string;
  body: ArtifactBody;
  status?: Exclude<ArtifactStatus, "committed">;
  citations?: Citation[];
  sourceContextIds?: string[];
}

export interface MemoryProposal {
  id: string;
  taskId: string;
  op: "add" | "update" | "delete";
  memoryId?: string;
  type?: string;
  title?: string;
  content?: string;
  tags?: string[];
  confidence?: number;
  status: "pending" | "accepted" | "rejected";
  createdAt: number;
  resolvedAt?: number;
}

export function isAgentBackendKind(value: unknown): value is AgentBackendKind {
  return (
    typeof value === "string" &&
    (AGENT_BACKENDS as readonly string[]).includes(value)
  );
}

export function isMemoryConsent(value: unknown): value is MemoryConsent {
  return value === "off" || value === "review" || value === "auto";
}

export function isRecoverableTurn(value: unknown): value is RecoverableTurn {
  const turn = recordOf(value);
  return Boolean(
    turn &&
    nonEmptyString(turn.turnId) &&
    typeof turn.userText === "string" &&
    finiteNumber(turn.checkpointAt) &&
    Number.isInteger(turn.iteration) &&
    Number(turn.iteration) >= 0 &&
    optionalString(turn.externalTurnId) &&
    nonEmptyStringArray(turn.unknownToolCallIds),
  );
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return (
    typeof value === "string" &&
    [
      "deep_read",
      "evidence_audit",
      "literature_map",
      "triage_table",
      "report",
      "note_draft",
      "annotation_set",
      "collection_diff",
      "citation_list",
    ].includes(value)
  );
}

export function isCitation(value: unknown): value is Citation {
  const citation = recordOf(value);
  return Boolean(
    citation &&
    isLibraryId(citation.itemLibraryID) &&
    nonEmptyString(citation.itemKey) &&
    optionalPositiveInteger(citation.page) &&
    optionalString(citation.section) &&
    optionalString(citation.quote) &&
    optionalString(citation.id),
  );
}

/** Validate a complete artifact before accepting a persisted JSON file. */
export function isArtifactRecord(value: unknown): value is ArtifactRecord {
  const artifact = recordOf(value);
  if (!artifact || !isArtifactKind(artifact.kind)) return false;
  const kind = artifact.kind;
  if (
    !nonEmptyString(artifact.id) ||
    !nonEmptyString(artifact.taskId) ||
    artifact.sessionId !== artifact.taskId ||
    !nonEmptyString(artifact.title) ||
    !["draft", "ready", "committed"].includes(String(artifact.status)) ||
    !positiveInteger(artifact.revision) ||
    !artifactBodyMatchesKind(kind, artifact.body) ||
    !Array.isArray(artifact.citations) ||
    !artifact.citations.every(isCitation) ||
    !nonEmptyStringArray(artifact.sourceContextIds) ||
    !Array.isArray(artifact.revisions) ||
    artifact.revisions.length === 0 ||
    !artifact.revisions.every((entry) => isArtifactRevision(entry, kind)) ||
    !optionalRecord(artifact.writeback, isArtifactWriteback) ||
    !finiteNumber(artifact.createdAt) ||
    !finiteNumber(artifact.updatedAt)
  ) {
    return false;
  }
  if (
    artifact.revisions.some(
      (entry, index) =>
        (entry as Record<string, unknown>).revision !== index + 1,
    )
  ) {
    return false;
  }
  const latest = artifact.revisions.at(-1) as Record<string, unknown>;
  return (
    latest.revision === artifact.revision &&
    jsonValueEquals(latest.body, artifact.body) &&
    jsonValueEquals(latest.citations, artifact.citations) &&
    jsonValueEquals(latest.sourceContextIds, artifact.sourceContextIds)
  );
}

export function summarizeArtifact(
  artifact: ArtifactRecord | ArtifactSummary,
): ArtifactSummary {
  return {
    id: artifact.id,
    sessionId: artifact.sessionId,
    taskId: artifact.taskId,
    kind: artifact.kind,
    title: artifact.title,
    status: artifact.status,
    revision: artifact.revision,
    writeback: artifact.writeback ? { ...artifact.writeback } : undefined,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

export function isLockedContextSnapshot(
  value: unknown,
): value is LockedContextSnapshot {
  const context = recordOf(value);
  if (
    !context ||
    context.version !== 1 ||
    !Number.isFinite(context.capturedAt) ||
    !Array.isArray(context.items) ||
    !context.items.every(isLockedItem)
  ) {
    return false;
  }
  return (
    optionalString(context.fingerprint) &&
    optionalRecord(context.collection, isLockedCollection) &&
    optionalRecord(context.savedSearch, isLockedSavedSearch) &&
    optionalRecord(context.reader, isLockedReader) &&
    optionalRecord(context.selection, isLockedSelection)
  );
}

export function artifactBodyMatchesKind(
  kind: ArtifactKind,
  body: unknown,
): body is ArtifactBody {
  const value = recordOf(body);
  if (!value) return false;
  if (kind === "deep_read" || kind === "report" || kind === "note_draft") {
    return value.type === "markdown" && typeof value.markdown === "string";
  }
  if (kind === "evidence_audit") {
    return (
      value.type === "evidence_audit" &&
      Array.isArray(value.claims) &&
      value.claims.every((entry) => {
        const claim = recordOf(entry);
        return Boolean(
          claim &&
          typeof claim.claim === "string" &&
          ["supported", "mixed", "unsupported", "unclear"].includes(
            String(claim.verdict),
          ) &&
          typeof claim.rationale === "string" &&
          stringArray(claim.citationIds),
        );
      })
    );
  }
  if (kind === "literature_map") {
    return (
      value.type === "literature_map" &&
      Array.isArray(value.nodes) &&
      value.nodes.every((entry) => {
        const node = recordOf(entry);
        return Boolean(
          node &&
          nonEmptyString(node.id) &&
          nonEmptyString(node.label) &&
          optionalString(node.summary) &&
          optionalRecord(node.item, isItemRef),
        );
      }) &&
      Array.isArray(value.edges) &&
      value.edges.every((entry) => {
        const edge = recordOf(entry);
        return Boolean(
          edge &&
          nonEmptyString(edge.source) &&
          nonEmptyString(edge.target) &&
          nonEmptyString(edge.relation) &&
          (edge.citationIds === undefined || stringArray(edge.citationIds)),
        );
      })
    );
  }
  if (kind === "triage_table") {
    return (
      value.type === "triage_table" &&
      Array.isArray(value.rows) &&
      value.rows.every((entry) => {
        const row = recordOf(entry);
        return Boolean(
          row &&
          isItemRef(row.item) &&
          nonEmptyString(row.title) &&
          ["keep", "review", "exclude"].includes(String(row.decision)) &&
          typeof row.reason === "string" &&
          (row.tags === undefined || stringArray(row.tags)),
        );
      })
    );
  }
  if (kind === "annotation_set") {
    return (
      value.type === "annotation_set" &&
      isItemRef(value.item) &&
      Array.isArray(value.highlights) &&
      value.highlights.every((entry) => {
        const highlight = recordOf(entry);
        return Boolean(
          highlight &&
          Number.isInteger(highlight.page) &&
          Number(highlight.page) >= 1 &&
          nonEmptyString(highlight.quote) &&
          optionalString(highlight.comment) &&
          optionalString(highlight.color),
        );
      })
    );
  }
  if (kind === "collection_diff") {
    return (
      value.type === "collection_diff" &&
      optionalRecord(value.collection, isCollectionRef) &&
      optionalString(value.name) &&
      Array.isArray(value.operations) &&
      value.operations.every(isCollectionOperation)
    );
  }
  return (
    value.type === "citation_list" &&
    optionalString(value.style) &&
    Array.isArray(value.entries) &&
    value.entries.every((entry) => {
      const citation = recordOf(entry);
      return Boolean(
        citation &&
        nonEmptyString(citation.citationId) &&
        typeof citation.rendered === "string",
      );
    })
  );
}

export function emptyLockedContext(
  capturedAt = Date.now(),
): LockedContextSnapshot {
  return withLockedContextFingerprint({
    version: 1,
    capturedAt,
    fingerprint: "",
    items: [],
  });
}

export function legacyContextSnapshot(
  context: SessionContext | undefined,
  capturedAt = Date.now(),
): LockedContextSnapshot {
  const items: LockedItemContext[] = context?.item
    ? [
        {
          ...context.item,
          id: `item:${context.item.libraryID}:${context.item.key}`,
          title: "",
          source: "legacy",
        },
      ]
    : [];
  const collection = context?.collection
    ? {
        ...context.collection,
        id: `collection:${context.collection.libraryID}:${context.collection.key}`,
        name: "",
      }
    : undefined;
  return withLockedContextFingerprint({
    version: 1,
    capturedAt,
    fingerprint: "",
    items,
    collection,
  });
}

export function withLockedContextFingerprint(
  context: Omit<LockedContextSnapshot, "fingerprint"> & {
    fingerprint?: string;
  },
): LockedContextSnapshot {
  const normalized: LockedContextSnapshot = {
    ...context,
    version: 1,
    items: uniqueLockedItems(context.items),
    fingerprint: "",
  };
  normalized.fingerprint = lockedContextFingerprint(normalized);
  return normalized;
}

export function mergeLockedContexts(
  locked: LockedContextSnapshot,
  incoming: LockedContextSnapshot,
): LockedContextSnapshot {
  return withLockedContextFingerprint({
    version: 1,
    capturedAt: incoming.capturedAt,
    fingerprint: "",
    items: [...locked.items, ...incoming.items],
    collection: incoming.collection ?? locked.collection,
    savedSearch: incoming.savedSearch ?? locked.savedSearch,
    reader: incoming.reader ?? locked.reader,
    selection: incoming.selection ?? locked.selection,
  });
}

export function lockedContextFingerprint(
  context: Pick<
    LockedContextSnapshot,
    "items" | "collection" | "savedSearch" | "reader" | "selection"
  >,
): string {
  const items = uniqueLockedItems(context.items)
    .map((item) => ({
      libraryID: item.libraryID,
      key: item.key,
      attachmentKey: item.attachmentKey ?? null,
    }))
    .sort((a, b) =>
      `${a.libraryID}:${a.key}:${a.attachmentKey ?? ""}`.localeCompare(
        `${b.libraryID}:${b.key}:${b.attachmentKey ?? ""}`,
      ),
    );
  const canonical = JSON.stringify({
    items,
    collection: context.collection
      ? [context.collection.libraryID, context.collection.key]
      : null,
    savedSearch: context.savedSearch
      ? [context.savedSearch.libraryID, context.savedSearch.key]
      : null,
    reader: context.reader
      ? [
          context.reader.libraryID,
          context.reader.attachmentKey,
          context.reader.pageIndex,
        ]
      : null,
    selection: context.selection
      ? [
          context.selection.attachmentKey ?? null,
          context.selection.pageIndex,
          context.selection.text,
        ]
      : null,
  });
  // FNV-1a is deterministic across the privileged Zotero sandbox and Node.
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ctx_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function lockedContextSourceIds(
  context: LockedContextSnapshot,
): string[] {
  return [
    ...context.items.map((item) => item.id),
    context.collection?.id,
    context.savedSearch?.id,
    context.reader?.id,
    context.selection?.id,
  ].filter((value): value is string => Boolean(value));
}

function uniqueLockedItems(
  items: readonly LockedItemContext[],
): LockedItemContext[] {
  const unique = new Map<string, LockedItemContext>();
  for (const item of items) {
    const key = `${item.libraryID}:${item.key}`;
    unique.set(key, { ...item });
  }
  return [...unique.values()];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}

function isLibraryId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 1);
}

function optionalRecord(
  value: unknown,
  validate: (candidate: unknown) => boolean,
): boolean {
  return value === undefined || validate(value);
}

function isItemRef(value: unknown): value is ItemRef {
  const item = recordOf(value);
  return Boolean(
    item && isLibraryId(item.libraryID) && nonEmptyString(item.key),
  );
}

function isCollectionRef(value: unknown): value is CollectionRef {
  return isItemRef(value);
}

function isLockedItem(value: unknown): value is LockedItemContext {
  const item = recordOf(value);
  return Boolean(
    item &&
    isItemRef(item) &&
    nonEmptyString(item.id) &&
    typeof item.title === "string" &&
    ["library", "reader", "legacy"].includes(String(item.source)) &&
    optionalString(item.attachmentKey),
  );
}

function isLockedCollection(value: unknown): value is LockedCollectionContext {
  const collection = recordOf(value);
  return Boolean(
    collection &&
    isCollectionRef(collection) &&
    nonEmptyString(collection.id) &&
    typeof collection.name === "string",
  );
}

function isLockedSavedSearch(
  value: unknown,
): value is LockedSavedSearchContext {
  const search = recordOf(value);
  return Boolean(
    search &&
    isCollectionRef(search) &&
    nonEmptyString(search.id) &&
    typeof search.name === "string",
  );
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nullableInteger(value: unknown): boolean {
  return value === null || Number.isInteger(value);
}

function isLockedReader(value: unknown): value is LockedReaderContext {
  const reader = recordOf(value);
  return Boolean(
    reader &&
    nonEmptyString(reader.id) &&
    isLibraryId(reader.libraryID) &&
    nonEmptyString(reader.attachmentKey) &&
    nullableString(reader.parentKey) &&
    typeof reader.title === "string" &&
    nullableString(reader.pageLabel) &&
    nullableInteger(reader.pageIndex),
  );
}

function isLockedSelection(value: unknown): value is LockedSelectionContext {
  const selection = recordOf(value);
  return Boolean(
    selection &&
    nonEmptyString(selection.id) &&
    typeof selection.text === "string" &&
    nullableString(selection.pageLabel) &&
    nullableInteger(selection.pageIndex) &&
    optionalString(selection.attachmentKey),
  );
}

function isCollectionOperation(value: unknown): boolean {
  const operation = recordOf(value);
  if (!operation) return false;
  const op = String(operation.op ?? "");
  if (!["create", "add", "remove", "tag_add", "tag_remove"].includes(op)) {
    return false;
  }
  if (
    !optionalRecord(operation.item, isItemRef) ||
    !optionalString(operation.value)
  ) {
    return false;
  }
  if (op === "add" || op === "remove") return isItemRef(operation.item);
  if (op === "tag_add" || op === "tag_remove") {
    return isItemRef(operation.item) && nonEmptyString(operation.value);
  }
  return true;
}

function isArtifactRevision(value: unknown, kind: ArtifactKind): boolean {
  const revision = recordOf(value);
  return Boolean(
    revision &&
    positiveInteger(revision.revision) &&
    artifactBodyMatchesKind(kind, revision.body) &&
    Array.isArray(revision.citations) &&
    revision.citations.every(isCitation) &&
    nonEmptyStringArray(revision.sourceContextIds) &&
    finiteNumber(revision.createdAt) &&
    isAgentBackendKind(revision.backend),
  );
}

function isArtifactWriteback(value: unknown): boolean {
  const writeback = recordOf(value);
  return Boolean(
    writeback &&
    ["none", "pending", "committed", "failed"].includes(
      String(writeback.state),
    ) &&
    [
      "zotero_note",
      "zotero_annotations",
      "zotero_collection",
      "zotero_tags",
      "knowledge_base",
    ].includes(String(writeback.target)) &&
    optionalString(writeback.targetRef) &&
    (writeback.revision === undefined || positiveInteger(writeback.revision)) &&
    (writeback.committedAt === undefined ||
      finiteNumber(writeback.committedAt)) &&
    optionalString(writeback.error),
  );
}

function jsonValueEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
