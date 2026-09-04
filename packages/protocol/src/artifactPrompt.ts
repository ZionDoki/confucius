import type { ArtifactKind } from "./research";
import { taskTemplate } from "./templates";

export interface ArtifactPromptRef {
  id: string;
  kind: ArtifactKind | string;
  title: string;
  revision?: number;
}

export interface ArtifactUpsertGuidanceInput {
  templateId?: string;
  artifacts?: readonly ArtifactPromptRef[];
}

export const MCP_TASK_GATEWAY_INSTRUCTIONS =
  "Use Zotero sources as evidence. Call artifact_upsert only for a durable research product, not for ordinary replies. All Zotero writes remain user-approved.";

/**
 * Artifacts are explicit research products, not a receipt for every turn.
 * Native, Codex/Kimi, and MCP hosts should share this wording.
 */
export function artifactUpsertGuidance(
  input: ArtifactUpsertGuidanceInput = {},
): string {
  const lines = [
    "Call artifact_upsert only when producing a durable, cited research product (deep_read, evidence_audit, literature_map, triage_table, note_draft, annotation_set, collection_diff, citation_list, or a cited report).",
    "Clarifications, status updates, short answers, and tool-only turns stay in the conversation. Do not wrap an ordinary reply as a new artifact.",
  ];

  const template = taskTemplate(input.templateId);
  if (template && template.id !== "freeform") {
    lines.push(
      `This task's template is "${template.title}". If the current request is that research product, call artifact_upsert with kind ${template.artifactKind} when the result is complete. Follow-ups and clarifications do not need an artifact.`,
    );
  }

  const artifacts = input.artifacts ?? [];
  if (artifacts.length > 0) {
    lines.push("Existing artifacts in this task:");
    for (const artifact of artifacts) {
      const revision =
        typeof artifact.revision === "number" ? `r${artifact.revision}` : "r1";
      lines.push(
        `- ${artifact.id} (${artifact.kind}, ${revision}): ${artifact.title}`,
      );
    }
    lines.push(
      "To revise one, call artifact_upsert with its id. Do not create a new artifact unless the user asked for a separate product.",
    );
  }

  lines.push(
    "When you create or revise an artifact, keep the chat reply brief: what you produced and why. Put the full body in the artifact.",
  );
  return lines.join("\n");
}
