/**
 * Clone data for a checkpoint without requiring a particular host global.
 *
 * Zotero's privileged loadSubScript sandbox does not expose every Window
 * global, including `structuredClone`. Model messages are JSON-shaped, so a
 * small recursive fallback is sufficient when the native implementation is
 * unavailable (or cannot clone a host object crossing compartments).
 */
export function cloneValue<T>(value: T): T {
  const native = nativeStructuredClone();
  if (native) {
    try {
      return native(value);
    } catch {
      // Fall back to the JSON-shaped clone below for host objects that the
      // native implementation cannot clone across compartments.
    }
  }
  return cloneFallback(value, new WeakMap<object, unknown>());
}

type StructuredClone = <T>(value: T) => T;

function nativeStructuredClone(): StructuredClone | undefined {
  try {
    const root =
      typeof globalThis === "object" && globalThis !== null
        ? (globalThis as unknown as { structuredClone?: unknown })
        : undefined;
    const candidate = root?.structuredClone;
    return typeof candidate === "function"
      ? (candidate as StructuredClone)
      : undefined;
  } catch {
    return undefined;
  }
}

function cloneFallback<T>(value: T, seen: WeakMap<object, unknown>): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const source = value as object;
  const previous = seen.get(source);
  if (previous !== undefined) {
    return previous as T;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(source, copy);
    for (const item of value) {
      copy.push(cloneFallback(item, seen));
    }
    return copy as T;
  }

  const copy: Record<string, unknown> = {};
  seen.set(source, copy);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = cloneFallback(item, seen);
  }
  return copy as T;
}
