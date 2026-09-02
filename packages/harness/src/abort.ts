/** AbortError that does not assume DOMException exists (Zotero sandbox). */
export function abortError(message = "Aborted"): Error {
  try {
    if (typeof DOMException === "function") {
      return new DOMException(message, "AbortError");
    }
  } catch {
    // Privileged Zotero scripts are not a Window; DOMException is missing.
  }
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Cross-compartment AbortError (window fetch vs sandbox Error). */
export function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "AbortError",
  );
}

/** Readable message for XPCOM / cross-compartment throws. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error && typeof error === "object") {
    const maybe = (error as { message?: unknown }).message;
    if (typeof maybe === "string" && maybe.trim()) {
      return maybe;
    }
  }
  const text = String(error);
  return text && text !== "[object Object]" ? text : "Unknown error";
}
