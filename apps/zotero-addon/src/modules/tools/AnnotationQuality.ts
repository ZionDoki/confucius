/** Shared generation guidance; lexical notices below are not semantic certification. */
export const ANNOTATION_COMMENT_GUIDANCE =
  "Explain what this passage establishes and why it matters to the user's question, usually in one to three short sentences. Preserve the author's metric, denominator and tested conditions. Add a limitation only when the source supports it; do not invent experimental settings, ability ceilings, deployment performance or causal conclusions. Label any interpretation explicitly. Do not force every comment to contain a benefit or limitation.";

export function annotationExplanationIssue(
  entry: Record<string, unknown>,
  policy: "key_explanations" | "all_explanations" | "advisory" = "advisory",
): string | null {
  if (
    policy === "advisory" ||
    (policy === "key_explanations" && entry.importance === "supporting")
  )
    return null;
  const comment = String(entry.comment ?? entry.rationale ?? "").trim();
  const quote = String(entry.quote ?? entry.text ?? "").trim();
  const normalize = (text: string) =>
    text.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
  if (!comment)
    return "Explain why this passage matters: identify its evidence, implication, limitation, or connection to the research question.";
  const clean = normalize(comment),
    original = normalize(quote);
  if (
    clean === original ||
    (original && original.includes(clean)) ||
    /^(important|keypoint|keyfinding|interesting|核心观点|重要|很重要|值得注意|关键内容|重点|核心结论)$/.test(
      clean,
    )
  ) {
    return "The comment repeats the passage or uses a generic label. Add an evidence-based interpretation or limitation; do not invent claims unsupported by the text.";
  }
  return null;
}
