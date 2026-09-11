import type { AgentBackendKind } from "./research";
import type { RuntimeModelSelection } from "./modelReasoning";

export type BtwSource =
  | {
      kind: "pdf";
      libraryID: number;
      attachmentKey: string;
      parentKey: string | null;
      title: string;
      pageIndex: number | null;
      pageLabel: string | null;
      rects?: number[][];
    }
  | { kind: "report"; taskId: string; artifactId: string; revision: number }
  | { kind: "conversation"; taskId: string; messageId: string };

/** Captured before focusing the prompt; never replaced by live reader state. */
export interface BtwSelection {
  source: BtwSource;
  text: string;
  surroundingText: string;
  capturedAt: number;
}

export interface BtwTurn {
  id: string;
  requestId: string;
  prompt: string;
  selection: BtwSelection;
  answer: string;
  status: "running" | "completed" | "failed" | "interrupted";
  error?: string;
  createdAt: number;
}

export interface BtwRecord {
  version: 1;
  id: string;
  sourceKey: string;
  source: BtwSource;
  backend: AgentBackendKind;
  runtimeModel?: RuntimeModelSelection;
  /** Endpoint identity only; credentials are resolved by the host. */
  endpointId?: string;
  createdAt: number;
  updatedAt: number;
  draft: string;
  turns: BtwTurn[];
}

export interface BtwPromptParams {
  btwId: string;
  requestId: string;
  text: string;
  selection: BtwSelection;
}

export interface BtwView {
  record: BtwRecord;
  sequence: number;
  storageError?: string;
}

export function btwSourceKey(source: BtwSource): string {
  return source.kind === "pdf"
    ? `pdf_${source.libraryID}_${source.parentKey ?? source.attachmentKey}`
    : `task_${source.taskId}`;
}

export function validateBtwSelection(value: unknown): BtwSelection {
  const selection = value as BtwSelection;
  const source = selection?.source;
  const id = (v: unknown) => typeof v === "string" && /^[\w-]+$/.test(v);
  if (
    !selection ||
    typeof selection.text !== "string" ||
    !selection.text.trim() ||
    selection.text.length > 100_000 ||
    typeof selection.surroundingText !== "string" ||
    selection.surroundingText.length > 20_000 ||
    !Number.isFinite(selection.capturedAt) ||
    !source
  )
    throw new Error("Invalid selection for btw");
  if (source.kind === "pdf") {
    if (
      !Number.isSafeInteger(source.libraryID) ||
      source.libraryID < 0 ||
      !id(source.attachmentKey) ||
      (source.parentKey !== null && !id(source.parentKey)) ||
      typeof source.title !== "string" ||
      (source.pageIndex !== null &&
        (!Number.isSafeInteger(source.pageIndex) || source.pageIndex < 0)) ||
      (source.pageLabel !== null && typeof source.pageLabel !== "string") ||
      (source.rects !== undefined &&
        (!Array.isArray(source.rects) ||
          source.rects.length > 1000 ||
          source.rects.some(
            (r) =>
              !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite),
          )))
    )
      throw new Error("Invalid PDF selection");
  } else if (source.kind === "report") {
    if (
      !id(source.taskId) ||
      !id(source.artifactId) ||
      !Number.isSafeInteger(source.revision) ||
      source.revision < 1
    )
      throw new Error("Invalid report selection");
  } else if (
    source.kind !== "conversation" ||
    !id(source.taskId) ||
    typeof source.messageId !== "string" ||
    !source.messageId
  )
    throw new Error("Invalid conversation selection");
  return JSON.parse(JSON.stringify(selection)) as BtwSelection;
}
