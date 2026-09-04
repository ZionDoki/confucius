export interface DroppedFileLike {
  name?: unknown;
  path?: unknown;
  mozFullPath?: unknown;
}

export interface FileDropTransferLike {
  files?: ArrayLike<DroppedFileLike> | null;
  mozItemCount?: number;
  mozGetDataAt?(format: string, index: number): unknown;
  types?: ArrayLike<string>;
}

/** Extract native file paths from both standard and Gecko drag payloads. */
export function droppedFilePaths(
  transfer: FileDropTransferLike | null | undefined,
): string[] {
  if (!transfer) return [];
  const paths: string[] = [];
  const add = (value: unknown) => {
    const candidate = filePath(value);
    if (candidate) paths.push(candidate);
  };
  const files = transfer.files;
  for (let index = 0; index < (files?.length ?? 0); index += 1) {
    add(files?.[index]);
  }
  if (typeof transfer.mozGetDataAt === "function") {
    const count = Math.max(
      Number(transfer.mozItemCount) || 0,
      files?.length ?? 0,
    );
    for (let index = 0; index < count; index += 1) {
      try {
        add(transfer.mozGetDataAt("application/x-moz-file", index));
      } catch {
        // A mixed drag can have non-file entries at individual indexes.
      }
    }
  }
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = path.replaceAll("/", "\\").toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function hasDroppedFiles(
  transfer: FileDropTransferLike | null | undefined,
): boolean {
  if (!transfer) return false;
  if ((transfer.files?.length ?? 0) > 0) return true;
  if ((Number(transfer.mozItemCount) || 0) > 0) return true;
  const types = transfer.types;
  for (let index = 0; index < (types?.length ?? 0); index += 1) {
    if (
      types?.[index] === "Files" ||
      types?.[index] === "application/x-moz-file"
    ) {
      return true;
    }
  }
  return false;
}

export function droppedFilename(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

function filePath(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const file = value as DroppedFileLike;
  for (const candidate of [file.path, file.mozFullPath]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}
