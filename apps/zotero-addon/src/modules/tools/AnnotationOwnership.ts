import {
  ALL_ANNOTATIONS,
  type AnnotationBatch,
  type AnnotationBatchFilter,
  type AnnotationProvenance,
} from "@confucius/protocol";
import { ResourceLocks, type JsonStorage } from "../host/RuntimeStorage";

export interface AnnotationOwnerContext {
  taskId: string;
  title?: string;
  createdAt?: number;
  agent?: string;
  runtime?: "native" | "plugin" | "sidecar";
}
export interface PdfOwnership {
  version: 1;
  batches: Record<
    string,
    {
      batch: AnnotationBatch;
      forbiddenColors: string[];
      colors: Record<string, string>;
    }
  >;
  marks: Record<string, AnnotationProvenance>;
  filter: AnnotationBatchFilter;
}
export function normalizedColor(value: string): string {
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(hex))
    return `#${[...hex.slice(1)].map((x) => x + x).join("")}`;
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : "";
}
const PALETTE = [
  "#ffd400",
  "#2ea8e5",
  "#a28ae5",
  "#5fb236",
  "#f19837",
  "#e56eee",
  "#ff6666",
  "#aaaaaa",
];
export function availableAnnotationColor(
  requested: string,
  forbidden: ReadonlySet<string>,
  allocated: readonly string[] = [],
): string {
  const desired = normalizedColor(requested) || PALETTE[0];
  if (!forbidden.has(desired)) return desired;
  const free = PALETTE.find(
    (color) => !forbidden.has(color) && !allocated.includes(color),
  );
  if (free) return free;
  // Deterministic, well-separated RGB candidates; never reuse a forbidden color.
  for (let n = 0; n < 0x1000000; n++) {
    const candidate = `#${((0x348bcb + n * 0x9e3779) & 0xffffff).toString(16).padStart(6, "0")}`;
    if (!forbidden.has(candidate) && !allocated.includes(candidate))
      return candidate;
  }
  throw new Error("No annotation color is available");
}
export function annotationBatchId(taskId: string): string {
  // Collision-free encoding, accepted by JsonStorage even for imported task IDs.
  return `batch_${Array.from(taskId)
    .map((c) => c.codePointAt(0)!.toString(16))
    .join("_")}`;
}
const changeListeners = new Set<(pdf: string) => void>();
export function onAnnotationOwnershipChanged(
  listener: (pdf: string) => void,
): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
export class AnnotationOwnership {
  private locks = new ResourceLocks();
  constructor(private storage: JsonStorage) {}
  async batch(context: AnnotationOwnerContext): Promise<AnnotationBatch> {
    const key = annotationBatchId(context.taskId);
    return this.locks.run([key], async () => {
      let batch = await this.storage.read<AnnotationBatch>(key);
      if (
        batch &&
        (batch.taskId !== context.taskId ||
          !batch.id ||
          !Number.isFinite(batch.createdAt))
      )
        throw new Error("Annotation batch record is damaged");
      if (!batch)
        batch = {
          id: key,
          taskId: context.taskId,
          name: "",
          createdAt: context.createdAt ?? Date.now(),
        };
      if (!batch.named && context.title?.trim()) {
        batch.name = `${context.title.trim().replace(/\s+/g, " ").slice(0, 32)} · ${context.taskId.slice(-6)}`;
        batch.named = true;
      }
      await this.storage.write(key, batch);
      return batch;
    });
  }
  async read(pdf: string): Promise<PdfOwnership> {
    const value = await this.storage.read<PdfOwnership>(`ownership_${pdf}`);
    if (value && (value.version !== 1 || !value.batches || !value.marks))
      throw new Error("Annotation ownership record is damaged");
    if (value) {
      for (const [id, entry] of Object.entries(value.batches)) {
        if (
          !entry?.batch ||
          entry.batch.id !== id ||
          !Number.isFinite(entry.batch.createdAt) ||
          !Array.isArray(entry.forbiddenColors) ||
          !entry.colors ||
          entry.forbiddenColors.some(
            (color) => normalizedColor(color) !== color,
          ) ||
          Object.values(entry.colors).some((color) => !normalizedColor(color))
        )
          throw new Error("Annotation color baseline is damaged");
      }
      for (const mark of Object.values(value.marks)) {
        if (
          !mark ||
          mark.createdBy !== "confucius-agent" ||
          !["planned", "created", "deleted"].includes(mark.status)
        )
          throw new Error("Annotation creation provenance is damaged");
      }
      value.filter ??= { ...ALL_ANNOTATIONS };
    }
    return (
      value ?? {
        version: 1,
        batches: {},
        marks: {},
        filter: { ...ALL_ANNOTATIONS },
      }
    );
  }
  async change<T>(
    pdf: string,
    work: (record: PdfOwnership) => T | Promise<T>,
  ): Promise<T> {
    return this.locks.run([pdf], async () => {
      const record = await this.read(pdf);
      const result = await work(record);
      await this.storage.write(`ownership_${pdf}`, record);
      for (const listener of changeListeners) {
        try {
          listener(pdf);
        } catch {
          /* UI cannot affect a persisted receipt. */
        }
      }
      return result;
    });
  }
  async freeze(pdf: string, context: AnnotationOwnerContext, colors: string[]) {
    const batch = await this.batch(context);
    const result = await this.change(pdf, (record) => {
      if (batch.pdfs?.includes(pdf) && !record.batches[batch.id])
        throw new Error(
          "The PDF color baseline was lost; restore its annotation records before adding marks",
        );
      record.batches[batch.id] ??= {
        batch,
        forbiddenColors: [
          ...new Set(colors.map(normalizedColor).filter(Boolean)),
        ],
        colors: {},
      };
      return record.batches[batch.id];
    });
    // Persist both files before permitting the first annotation write. A crash
    // between them can only leave a reusable baseline, never an untracked write.
    await this.locks.run([batch.id], async () => {
      const current = await this.storage.read<AnnotationBatch>(batch.id);
      if (!current) throw new Error("Annotation batch record was lost");
      if (!current.pdfs?.includes(pdf)) {
        current.pdfs = [...(current.pdfs ?? []), pdf];
        await this.storage.write(batch.id, current);
      }
    });
    return result;
  }
  async color(
    pdf: string,
    batchId: string,
    requested: string,
  ): Promise<string> {
    return this.change(pdf, (record) => {
      const entry = record.batches[batchId];
      if (!entry)
        throw new Error(
          "PDF color baseline is missing; resume after restoring its batch record",
        );
      const desired = normalizedColor(requested) || PALETTE[0];
      entry.colors[desired] ??= availableAnnotationColor(
        desired,
        new Set(entry.forbiddenColors),
        Object.values(entry.colors),
      );
      return entry.colors[desired];
    });
  }
  async assertColor(pdf: string, batchId: string, color: string) {
    const batch = (await this.read(pdf)).batches[batchId];
    if (
      !batch ||
      !normalizedColor(color) ||
      batch.forbiddenColors.includes(normalizedColor(color))
    )
      throw new Error(
        "Annotation color conflicts with the PDF's task-start baseline",
      );
  }
  async plan(
    pdf: string,
    key: string,
    batchId: string,
    context: AnnotationOwnerContext,
    expected: string,
  ) {
    await this.change(pdf, (record) => {
      if (!record.batches[batchId]) throw new Error("Annotation batch missing");
      if (record.marks[key])
        throw new Error("Annotation identity was already allocated");
      record.marks[key] = {
        batchId,
        createdBy: "confucius-agent",
        taskId: context.taskId,
        agent: context.agent ?? "native",
        runtime: context.runtime,
        status: "planned",
        expected,
      };
    });
  }
  async confirm(
    pdf: string,
    key: string,
    expected: string,
    createdAt = Date.now(),
  ) {
    await this.change(pdf, (record) => {
      const mark = record.marks[key];
      if (
        !mark ||
        mark.status === "deleted" ||
        (mark.status === "planned" && mark.expected !== expected)
      )
        throw new Error("Annotation creation could not be verified");
      if (mark.status === "planned") mark.createdAt = createdAt;
      mark.status = "created";
      delete mark.expected;
    });
  }
  async owned(pdf: string, key: string): Promise<AnnotationProvenance | null> {
    const mark = (await this.read(pdf)).marks[key];
    return mark?.createdBy === "confucius-agent" && mark.status === "created"
      ? mark
      : null;
  }
  async modified(
    pdf: string,
    key: string,
    context: AnnotationOwnerContext,
    at: number,
    deleted = false,
  ) {
    await this.change(pdf, (record) => {
      const mark = record.marks[key];
      if (
        !mark ||
        mark.createdBy !== "confucius-agent" ||
        mark.status === "planned"
      )
        throw new Error("Annotation ownership is unverified");
      if (mark.status === "deleted") {
        if (deleted) return;
        throw new Error("Deleted annotations cannot be modified");
      }
      mark.modifiedAt = at;
      mark.modifiedBy = {
        taskId: context.taskId,
        agent: context.agent ?? "native",
        runtime: context.runtime,
      };
      if (deleted) mark.status = "deleted";
    });
  }
}
