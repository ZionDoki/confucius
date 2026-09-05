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
  "Use Zotero sources as evidence. Call artifact_upsert only to save a cited research file, not for ordinary replies. Zotero writes require user approval.";

/**
 * Artifacts are explicit research products, not a receipt for every turn.
 * Native, Codex/Kimi, and MCP hosts should share this wording.
 */
export function artifactUpsertGuidance(
  input: ArtifactUpsertGuidanceInput = {},
): string {
  const lines = [
    "Call artifact_upsert only to save a cited research file (deep_read, evidence_audit, literature_map, triage_table, note_draft, annotation_set, collection_diff, citation_list, or a cited report).",
    "Leave clarifications, status updates, short answers, and tool-only turns in the conversation. Do not save an ordinary reply as an artifact.",
  ];

  const template = taskTemplate(input.templateId);
  if (template && template.id !== "freeform") {
    const products = [
      template.artifactKind,
      ...(template.additionalArtifactKinds ?? []),
    ];
    lines.push(
      `This task uses the "${template.title}" template. For that output, call artifact_upsert for ${products.map((kind) => `kind ${kind}`).join(" and ")}. Follow-ups and clarifications do not need an artifact.`,
    );
  }

  const artifacts = input.artifacts ?? [];
  if (artifacts.length > 0) {
    lines.push("Saved files in this task:");
    for (const artifact of artifacts) {
      const revision =
        typeof artifact.revision === "number" ? `r${artifact.revision}` : "r1";
      lines.push(
        `- ${artifact.id} (${artifact.kind}, ${revision}): ${artifact.title}`,
      );
    }
    lines.push(
      "To revise a file, call artifact_upsert with its id. Create a new artifact only when the user asks for a separate file.",
    );
  }

  lines.push(
    "After creating or revising an artifact, state what changed. Put the full content in the artifact.",
  );
  return lines.join("\n");
}
