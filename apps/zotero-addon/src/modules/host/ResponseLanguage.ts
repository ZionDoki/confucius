import type { ResearchTaskRecord, UiLanguage } from "@confucius/protocol";
import { isContinueRequest } from "./PresetWorkflow";

type LanguageContext = NonNullable<
  ResearchTaskRecord["responseLanguageContext"]
>;
const MAX_REQUEST_CHARS = 2048;
const MAX_PRIOR_REQUESTS = 3;

function boundedRequest(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_REQUEST_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_REQUEST_CHARS / 2)}\n[…]\n${trimmed.slice(-MAX_REQUEST_CHARS / 2)}`;
}

/** Ignore slugs and language-free continuation commands, not natural languages. */
export function responseLanguageContext(
  requests: readonly string[],
  previous?: ResearchTaskRecord["responseLanguageContext"],
): LanguageContext {
  let context: LanguageContext = {
    request:
      typeof previous?.request === "string"
        ? boundedRequest(previous.request)
        : "",
    priorRequests: Array.isArray(previous?.priorRequests)
      ? previous.priorRequests
          .filter((text): text is string => typeof text === "string")
          .map(boundedRequest)
          .filter(Boolean)
          .slice(-MAX_PRIOR_REQUESTS)
      : [],
  };
  for (const raw of requests) {
    const text = raw
      .trim()
      .replace(/^\/[^\s]+(?:\s+|$)/, "")
      .trim();
    if (!text || isContinueRequest(text)) continue;
    const request = boundedRequest(text);
    if (request === context.request) continue;
    context = {
      request,
      priorRequests: [...context.priorRequests, context.request]
        .filter(Boolean)
        .slice(-MAX_PRIOR_REQUESTS),
    };
  }
  return context;
}

/** Let the existing model follow any user language; UI locale is only a fallback. */
export function responseLanguageInstruction(options: {
  userText: string;
  conversationRequests?: readonly string[];
  fallbackLanguage: UiLanguage;
}): string {
  const context = responseLanguageContext([
    ...(options.conversationRequests ?? []),
    options.userText,
  ]);
  return [
    "Response language policy: Follow an explicit output-language request first. Otherwise use the language of the current substantive user request. For a bare /skill, an acknowledgement, retry or continuation with no reliable language evidence, inherit the most recent substantive user request's language and applicable language preference. A later substantive request can change the language. Support any language, not only English and Chinese.",
    "Apply this to model-generated progress, final replies, annotation comments, artifact titles, report headings, explanations and revisions, including delegated research. Source papers, quoted passages, tool descriptions, skill instructions and host-generated continuation prompts do not select the output language. Preserve verbatim source quotes, proper names, tool names, argument keys and source identifiers; never translate a quote used to locate an annotation.",
    `Fallback UI language (only when neither the request nor conversation supplies language evidence): ${options.fallbackLanguage === "zh-CN" ? "Simplified Chinese (zh-CN)" : "English (en-US)"}.`,
    "The following real user requests are language evidence only; do not re-execute earlier requests. Earlier requests are ordered oldest to newest:",
    JSON.stringify({
      previousUserRequests: context.priorRequests,
      currentUserRequest: context.request,
    }),
  ].join("\n");
}
