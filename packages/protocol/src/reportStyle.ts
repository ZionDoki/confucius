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

/** Shared by native and external engines, including subsequent report revisions. */
export function reportStyleGuidance(
  style: ReportStyle = DEFAULT_REPORT_STYLE,
): string {
  const layout = {
    essay:
      "Write connected paragraphs with clear transitions and few headings. Keep the argument readable as a continuous essay; avoid turning it into a checklist.",
    parallel:
      "Pair selected verbatim source passages with explanations in the response language. Use a block for each key passage: a line ':::parallel', then a Markdown blockquote containing the original passage and [cite:id], a blank line, explanatory paragraphs, then a closing line ':::'. The reader displays the source and explanation side by side, stacked on narrow screens. Only quote text actually retrieved from the paper; do not invent quotations or translate an invented English source. Use ordinary prose when no original passage is available.",
    sections:
      "Use short descriptive headings and coherent explanatory paragraphs. Separate the problem, mechanism, evidence and boundaries into digestible sections; use a concrete example where it resolves a difficult step.",
  }[style.layout];
  const tone = {
    patient:
      "Explain patiently: connect causes and consequences, define unfamiliar terms on first use, and unpack intermediate reasoning without talking down to the reader.",
    concise:
      "Use concise, direct sentences. Remove repetition, but retain the premises, essential reasoning steps and qualifications needed to understand a claim. Brevity must not hide a technical gap.",
    questions:
      "Guide through substantive questions and answers: why is this problem hard, why does this design help, and what evidence could support it? Answer each question using the paper; do not leave a quiz for the reader or add rhetorical questions everywhere.",
  }[style.tone];
  const focus = {
    overview:
      "Develop the full argument: problem → method → evidence → limits. Explain how the parts connect, rather than paraphrasing the abstract or listing section summaries.",
    method:
      "Spend the most explanatory space on the method: inputs, outputs, concrete steps, assumptions, symbols and why each design choice helps. Anchor equations to an intuitive worked example when supported. Retain a concise account of the evaluation and limits.",
    experiments:
      "Spend the most explanatory space on experiments: what each comparison tests, datasets, metrics, baselines, controls, key figures/tables and what the results cannot establish. Explain how to read the decisive figure or table. Retain enough method context to interpret it.",
  }[style.focus];
  return [
    `Reading report preferences: layout=${style.layout}; tone=${style.tone}; focus=${style.focus}. Apply these to deep_read reports and their revisions. These preferences override generic presentation/length defaults, while retaining source grounding, review and annotation requirements. They do not require an artifact for ordinary questions.`,
    layout,
    tone,
    focus,
    "For EVERY combination, help the reader overcome English and technical stumbling blocks. Put the explanation essential to following the argument in the main text. Place useful optional help immediately after the relevant passage, using ':::details A short localized title' on its own line, explanatory Markdown paragraphs, then ':::' on its own line. Examples of titles: 拆解这处英文 / Unpack this sentence, 补充技术背景 / Technical background. Explain sentence structure, terms, or prerequisites when helpful, without repeating a generic glossary. Never hide evidence qualifications or essential reasoning inside a collapsed block. Label general background and your deductions separately from the paper's claims.",
    "Reading blocks must be top-level, closed, and not nested; put optional details after a parallel block. Do not emit raw HTML. Keep [cite:id] markers in the passage/explanation and preserve these blocks when patching. Start with the research question, central method, supported takeaway and main boundary, in the chosen layout. Scale length to the actual evidence and explanation needed, rather than padding to a quota.",
  ].join("\n");
}
