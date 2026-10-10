/** Use the batch start time, so retries and later annotations share one label. */
export function annotationBatchTime(createdAt: number): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Invalid annotation batch time");
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
