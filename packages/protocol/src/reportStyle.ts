/** Independent reading preferences, saved with the task rather than the engine. */
export const REPORT_STYLE_OPTIONS = {
  layout: ["essay", "parallel", "sections"],
  tone: ["patient", "concise", "questions"],
  focus: ["overview", "method", "experiments"],
} as const;

export interface ReportStyle {
  layout: (typeof REPORT_STYLE_OPTIONS.layout)[number];
  tone: (typeof REPORT_STYLE_OPTIONS.tone)[number];
  focus: (typeof REPORT_STYLE_OPTIONS.focus)[number];
}

export const DEFAULT_REPORT_STYLE: Readonly<ReportStyle> = Object.freeze({
  layout: "sections",
  tone: "patient",
  focus: "overview",
});

export function isReportStyle(value: unknown): value is ReportStyle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(REPORT_STYLE_OPTIONS).every(([key, options]) =>
    (options as readonly unknown[]).includes(record[key]),
  );
}

export function restoreReportStyle(value: unknown): ReportStyle | undefined {
  return isReportStyle(value)
    ? { layout: value.layout, tone: value.tone, focus: value.focus }
    : undefined;
}

/** Shared writing recipe for drafting and direct revision in every engine. */
export function reportStyleGuidance(
  style: ReportStyle = DEFAULT_REPORT_STYLE,
): string {
  const layout = {
    essay: [
      "Organize a continuous argument in connected paragraphs, with few headings. Each transition should explain why the next point follows; do not disguise a section checklist as prose.",
      "Demonstration: The difficulty is not finding an action, but reaching the state where it becomes useful. This is why the method retains earlier steps. Its evaluation must therefore test complete sequences, not just isolated clicks.",
    ],
    parallel: [
      "Select decisive original sentences, not arbitrary excerpts. For each, explain its meaning, role in the argument and material boundary in the response language. Use :::parallel on its own line, a Markdown blockquote with the verbatim retrieved passage and [cite:id], a blank line, explanatory paragraphs, and a closing :::. Narrow readers stack the two columns. If original text is unavailable, use ordinary prose and identify the source limit; never manufacture a quotation.",
      "Syntax demonstration only: :::parallel\n> [retrieved original sentence] [cite:source_id]\n\n[Explain what it means, why it matters, and what it does not establish.]\n:::",
    ],
    sections: [
      "Use descriptive headings for the research problem, mechanism, evidence and boundaries. Each section develops an explanation with connected paragraphs; use an example when it bridges a difficult step. Organize around understanding, not the paper's section numbering.",
      "Demonstration heading: Why remembering earlier steps changes the search. Follow it with the obstacle, the mechanism addressing it, and the condition under which it helps.",
    ],
  }[style.layout];
  const tone = {
    patient: [
      "Define unfamiliar terms on first use, connect causes to consequences and unpack intermediate reasoning. Assume research experience but no specialist knowledge of this paper's field. Use a concrete example, labelled illustrative if not from the paper, to bridge an actual technical gap.",
      "Demonstration: A baseline is the comparison method used in the same experiment. Holding the task set fixed helps us ask whether the method, rather than an easier task selection, accounts for the difference.",
    ],
    concise: [
      "Use direct sentences and remove repeated results, ornamental introductions and unnecessary background. Keep the premises, essential reasoning and qualifications. Concise does not mean replacing explanation with terminology or shortening every paragraph mechanically.",
      "Demonstration: Both methods used the same tasks. The difference therefore concerns performance on those tasks; it does not establish performance on other applications.",
    ],
    questions: [
      "Choose substantive questions whose answers advance the argument: why the problem is hard, why the design helps, and what the evidence establishes. Answer immediately from the paper. Do not leave exercises unanswered or add rhetorical questions to every paragraph. In essay layout place questions naturally in prose; in parallel layout answer beside the source.",
      "Demonstration: Why is a successful first step insufficient? Later actions depend on the state it creates. The evaluation therefore needs to distinguish starting a sequence from completing it.",
    ],
  }[style.tone];
  const focus = {
    overview: [
      "Read across the problem, method, evaluation and limitations. Develop the full argument: problem → method → evidence → limits. Explain why the problem calls for this design and how the evidence supports the takeaway; do not paraphrase the abstract or concatenate section summaries.",
      "Demonstration outline: obstacle → design response → decisive comparison → supported conclusion → applicability condition.",
    ],
    method: [
      "During reading, locate inputs, outputs, steps, design motivations, assumptions, equations and the passages connecting them. Spend the most explanatory space on how the mechanism works and why each important choice helps. Explain symbols in context and walk through an illustrative input when supported. Retain evaluation and limits; do not invent a formula, ablation or implementation detail the paper does not provide.",
      "Demonstration outline: input state → one transformation → resulting output → reason for that choice → assumption needed → evidence that the mechanism helps.",
    ],
    experiments: [
      "During reading, locate comparison purposes, datasets/populations, metrics, baselines, controls, experiment settings and decisive figures/tables. Spend the most explanatory space on how to interpret them. Preserve denominators, intervals and absolute versus relative differences. Explain what each comparison can and cannot establish, with enough method context to make it intelligible. Use visible table evidence when headings are ambiguous; unresolved extraction is not an author error.",
      "Demonstration outline: question tested → fixed conditions and changing factor → metric and denominator → how to read the result → supported conclusion and untested setting.",
    ],
  }[style.focus];
  return [
    `Reading report preferences: layout=${style.layout}; tone=${style.tone}; focus=${style.focus}. Apply this recipe to deep_read drafting and revisions. Priority: the current user's explicit instructions, then selected report preferences, then generic defaults. Ordinary questions do not require an artifact.`,
    "Audience: a researcher crossing into an unfamiliar field. Before writing, organize working points as claim → retrieved source location → explanation → boundary. These are private working material, not an extra artifact or mandatory form. Read relevant evidence before asserting a claim; focus determines where to investigate and explain most, not which contrary evidence to ignore.",
    "Compose the three dimensions: focus determines the evidence and explanatory emphasis, tone determines how reasoning is explained, layout determines how that explanation is arranged. All examples below are demonstrations, NOT paper evidence. Never copy their invented setting or placeholder citations into the report.",
    "LAYOUT",
    ...layout,
    "VOICE",
    ...tone,
    "READING AND EXPLANATORY FOCUS",
    ...focus,
    "For EVERY combination, help the reader overcome English and technical stumbling blocks. Put essential reasoning and evidence qualifications in the main text. Place optional sentence unpacking, terms or prerequisites immediately after the relevant passage using :::details A short localized title, explanatory Markdown, then ::: on its own line. Do not add a generic glossary or hide a premise in collapsed help. Label general background, illustrative examples and your deductions separately from the paper's claims.",
    "Reading blocks must be top-level, closed and not nested; optional details follow a parallel block. Do not emit raw HTML. Keep [cite:id] markers in passages and explanations. Start with the research question, central method, supported takeaway and main boundary, expressed in the chosen layout. Use an evidence table only when it clarifies comparisons. No fixed length, heading, quotation or table quota: scale to the actual source and explanation needed. Preserve numerical scope and avoid repeating the same result.",
    "Save one readable report. Keep exact figures in one explanatory location and make the opening takeaway qualitative unless a number is essential. Include an annotation appendix only for actual saved or unresolved annotation work, and a short plain-language reading map connecting problem → method → evidence → limits. Keep library IDs, item/attachment/annotation keys, tool receipts and other implementation metadata out of the prose; inline [cite:id] markers provide source access without an extra metadata list. The host may make one direct improvement pass with the current model. Do not wait for a review verdict, solicit approval for the report, or run a grading/repair loop. ready means deliverable, not certified correct. When evidence is limited, narrow the claim and state the limit rather than filling gaps.",
  ].join("\n");
}
