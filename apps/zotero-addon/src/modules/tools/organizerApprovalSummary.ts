/**
 * Lokalisierte Ein-Zeilen-Zusammenfassung für Organizer-Zuweisungs-Karten.
 * Klein gehalten und in einer eigenen Datei, damit das Flex-Annotations-
 * Feature ohne Zerschneiden von approvalSummary.ts entfernt werden kann.
 */

/** Leitet eine lokalisiere Kurzbeschreibung für Zuweisungs-/Entfernungs-Tools. */
export function describeOrganizerApproval(
  toolName: string,
  args: Record<string, unknown>,
  language: "en-US" | "zh-CN" = "en-US",
): string | undefined {
  if (
    toolName === "organizer_assign_annotations" ||
    toolName === "annotations_assign"
  ) {
    const count = Array.isArray(args.assignments) ? args.assignments.length : 0;
    if (language === "zh-CN") {
      return `分配 ${count} 条标注至 Flex Annotations 大纲`;
    }
    if (String(language).startsWith("de")) {
      return `${count} Annotation${count === 1 ? "" : "en"} der Flex-Annotations-Gliederung zuweisen`;
    }
    return `Assign ${count} annotation${count === 1 ? "" : "s"} to Flex Annotations outline`;
  }
  if (
    toolName === "organizer_unassign_annotations" ||
    toolName === "annotations_unassign"
  ) {
    const count = Array.isArray(args.assignments)
      ? args.assignments.length
      : Array.isArray(args.keys)
        ? args.keys.length
        : typeof args.key === "string" && args.key
          ? 1
          : 0;
    if (language === "zh-CN") {
      return `移除 ${count} 条标注的大纲归类`;
    }
    if (String(language).startsWith("de")) {
      return `Gliederungszuweisung von ${count} Annotation${count === 1 ? "" : "en"} entfernen`;
    }
    return `Unassign ${count} annotation${count === 1 ? "" : "s"} from Flex Annotations outline`;
  }
  return undefined;
}
