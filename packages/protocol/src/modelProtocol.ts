/** Wire protocol is independent of model names and reasoning parameter overrides. */
export const MODEL_API_PROTOCOLS = [
  "auto",
  "openai",
  "responses",
  "anthropic",
  "gemini",
  "ollama",
] as const;
export type ModelApiProtocol = (typeof MODEL_API_PROTOCOLS)[number];
export type ResolvedModelProtocol = Exclude<ModelApiProtocol, "auto">;

export function isModelApiProtocol(value: unknown): value is ModelApiProtocol {
  return (
    typeof value === "string" &&
    (MODEL_API_PROTOCOLS as readonly string[]).includes(value)
  );
}

/** Auto only uses unambiguous URLs. Generic gateways retain Chat Completions. */
export function resolveModelProtocol(
  baseUrl: string,
  protocol: ModelApiProtocol = "auto",
): ResolvedModelProtocol {
  if (protocol !== "auto") return protocol;
  try {
    const url = new URL(baseUrl.trim());
    const path = url.pathname.replace(/\/+$/, "");
    if (/\/api\/(?:chat|tags)$/.test(path)) return "ollama";
    if (/\/responses$/.test(path)) return "responses";
    if (/\/messages$/.test(path) || url.hostname === "api.anthropic.com")
      return "anthropic";
    if (
      /:(?:streamGenerateContent|generateContent)$/.test(path) ||
      url.hostname === "generativelanguage.googleapis.com"
    )
      return "gemini";
  } catch {
    /* Config validation reports malformed URLs. */
  }
  return "openai";
}

/** Preserve gateway prefixes and query values, stripping only known API routes. */
export function modelApiRoot(
  baseUrl: string,
  protocol: ResolvedModelProtocol,
): URL {
  const url = new URL(baseUrl.trim());
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(
    /\/(?:chat\/completions|responses|messages|models\/[^/]+:(?:streamGenerateContent|generateContent)|api\/(?:chat|tags))$/i,
    "",
  );
  if (protocol === "ollama") path = path.replace(/\/api$/i, "");
  if (!path)
    path =
      protocol === "ollama" ? "" : protocol === "gemini" ? "/v1beta" : "/v1";
  url.pathname = path || "/";
  url.hash = "";
  return url;
}

export function modelApiUrl(
  baseUrl: string,
  protocol: ResolvedModelProtocol,
  path: string,
): string {
  const url = modelApiRoot(baseUrl, protocol);
  url.pathname = url.pathname.replace(/\/+$/, "") + path;
  return url.toString();
}

export function modelApiHeaders(
  protocol: ResolvedModelProtocol,
  apiKey = "",
): Record<string, string> {
  if (protocol === "anthropic")
    return {
      "anthropic-version": "2023-06-01",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    };
  if (protocol === "gemini") return apiKey ? { "x-goog-api-key": apiKey } : {};
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}
