import type { ReasoningEffort } from "./rpc";

export interface ModelReasoning {
  /** Unknown models keep the provider default; never invent supported controls. */
  source: "documented" | "unknown";
  efforts: readonly ReasoningEffort[];
  transport: "openai" | "thinking" | "ollama" | "none";
}

/** Native API capabilities, independent of CLI catalogs. See docs/model-selection.md. */
export function modelReasoning(model: string, baseUrl = ""): ModelReasoning {
  const id = model.toLowerCase().split("/").at(-1) ?? "";
  const profile = (
    transport: ModelReasoning["transport"],
    ...efforts: ReasoningEffort[]
  ): ModelReasoning => ({
    source: "documented",
    transport,
    efforts: ["auto", ...efforts],
  });
  if (/\/api\/chat\/?$/.test(baseUrl)) {
    if (/^gpt-oss(?:[:\-]|$)/.test(id))
      return profile("ollama", "low", "medium", "high");
    if (/^(qwen3|deepseek-r1)(?::|$)/.test(id))
      return profile("ollama", "off", "on");
    return { source: "unknown", transport: "none", efforts: ["auto"] };
  }
  if (/^deepseek-v4-(flash|pro)(?:-|$)/.test(id))
    return profile("thinking", "off", "low", "high", "max");
  if (/^kimi-k2[.-][56](?:-|$)/.test(id))
    return profile("thinking", "off", "on");
  if (/^gpt-6-astra(?:-|$)/.test(id))
    return profile("openai", "low", "medium", "high", "xhigh", "max");
  if (/^gpt-5\.6(?:-(sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/.test(id))
    return profile("openai", "off", "low", "medium", "high", "xhigh", "max");
  if (/^gpt-5\.[245](?:-\d{4}-\d{2}-\d{2})?$/.test(id))
    return profile("openai", "off", "low", "medium", "high", "xhigh");
  if (/^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/.test(id))
    return profile("openai", "off", "low", "medium", "high");
  if (/^gpt-5(?:-(mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.test(id))
    return profile("openai", "minimal", "low", "medium", "high");
  if (/^(o1|o3|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(id))
    return profile("openai", "low", "medium", "high");
  return { source: "unknown", transport: "none", efforts: ["auto"] };
}

export function normalizeModelEffort(
  model: string,
  baseUrl: string,
  effort: unknown,
): ReasoningEffort {
  return modelReasoning(model, baseUrl).efforts.includes(
    effort as ReasoningEffort,
  )
    ? (effort as ReasoningEffort)
    : "auto";
}

export function modelReasoningBody(
  model: string,
  baseUrl: string,
  effort?: ReasoningEffort,
): Record<string, unknown> {
  const capability = modelReasoning(model, baseUrl);
  if (!effort || effort === "auto" || !capability.efforts.includes(effort))
    return {};
  switch (capability.transport) {
    case "openai":
      return { reasoning_effort: effort === "off" ? "none" : effort };
    case "ollama":
      return {
        think: effort === "off" ? false : effort === "on" ? true : effort,
      };
    case "thinking":
      return {
        thinking: { type: effort === "off" ? "disabled" : "enabled" },
        ...(effort === "off" || effort === "on"
          ? {}
          : { reasoning_effort: effort }),
      };
    default:
      return {};
  }
}

/** External values are opaque: ACP can use option IDs other than API effort names. */
export interface RuntimeModelSelection {
  modelId: string;
  reasoningEffort?: string;
}

export interface RuntimeModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
  reasoningOptions?: { value: string; label: string }[];
  defaultReasoningEffort?: string;
  reasoningConfigId?: string;
}

export function runtimeModelSelection(
  value: unknown,
): RuntimeModelSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.modelId !== "string" || !raw.modelId.trim()) return undefined;
  return {
    modelId: raw.modelId,
    ...(typeof raw.reasoningEffort === "string" && raw.reasoningEffort
      ? { reasoningEffort: raw.reasoningEffort }
      : {}),
  };
}
