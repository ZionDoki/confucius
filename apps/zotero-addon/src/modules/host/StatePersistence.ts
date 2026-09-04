/** Serialize host state without model-only page images or transient markers. */
export function stringifyDurableHostState(value: unknown): string {
  return JSON.stringify(value, (key, candidate) => {
    if (key === "transientMedia" || key === "images" || key === "transient") {
      return undefined;
    }
    return candidate;
  });
}
