import type { UiLanguage } from "@confucius/protocol";

/** Keep research prose in the user's configured language, including tool arguments. */
export function responseLanguageInstruction(language: UiLanguage): string {
  return language === "zh-CN"
    ? "输出语言：简体中文（用户设置 zh-CN）。面向用户的进度说明、最终回复、批注 comment、成果标题和报告正文均使用简体中文，包括后续修复与继续执行。论文原文引文 quote、专有名词、工具名称、参数键和来源标识保留原文，不要翻译用于定位的 quote。英文论文和英文工具说明不改变回复语言。"
    : "Response language: English (user setting en-US). Use English for user-facing progress, final replies, annotation comments, artifact titles, and report prose, including repairs and continuations. Preserve verbatim source quotes, proper names, tool names, argument keys, and source identifiers; never translate a quote used to locate an annotation. The language of source papers and tool instructions does not change the response language.";
}
