import type { AnnotationBatch } from "@confucius/protocol";

/** Use the batch start time, so retries and later annotations share one label. */
export function annotationBatchTime(createdAt: number): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Invalid annotation batch time");
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function annotationBatchTag(batch: AnnotationBatch): string {
  return `Confucius 批次：${batch.timeLabel ?? annotationBatchTime(batch.createdAt)}`;
}

/** Called only for verified ownership; preserve manually edited and unrelated tags. */
export function legacyBatchTagChange(
  tags: readonly string[],
  batch: AnnotationBatch,
): { remove: string[]; add: string } | undefined {
  const add = annotationBatchTag(batch);
  const oldName = `Confucius 批次：${batch.name}`;
  const oldDate = `Confucius 批次日期：${annotationBatchTime(batch.createdAt).slice(0, 10)}`;
  const remove = tags.filter(
    (tag) => tag !== add && (tag === oldName || tag === oldDate),
  );
  return remove.length ? { remove, add } : undefined;
}
