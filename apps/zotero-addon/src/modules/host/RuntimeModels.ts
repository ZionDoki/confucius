import type {
  RuntimeModelOption,
  RuntimeModelSelection,
} from "@confucius/protocol";

interface ModelRpc {
  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T>;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export async function codexModels(
  rpc: ModelRpc,
): Promise<RuntimeModelOption[]> {
  const models = new Map<string, RuntimeModelOption>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await rpc.request<Record<string, unknown>>("model/list", {
      limit: 100,
      includeHidden: false,
      ...(cursor ? { cursor } : {}),
    });
    for (const raw of array(page.data)) {
      const item = record(raw);
      const id = String(item.model ?? item.id ?? "");
      if (!id || item.hidden === true) continue;
      const options = array(item.supportedReasoningEfforts).flatMap((raw) => {
        const effort = record(raw);
        return typeof effort.reasoningEffort === "string"
          ? [{ value: effort.reasoningEffort, label: effort.reasoningEffort }]
          : [];
      });
      models.set(id, {
        id,
        label: String(item.displayName ?? id),
        isDefault: item.isDefault === true,
        reasoningOptions: options,
        defaultReasoningEffort:
          typeof item.defaultReasoningEffort === "string"
            ? item.defaultReasoningEffort
            : undefined,
      });
    }
    cursor =
      typeof page.nextCursor === "string" && page.nextCursor
        ? page.nextCursor
        : undefined;
    if (cursor && cursors.has(cursor))
      throw new Error("Codex model catalog repeated a cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor && cursors.size < 20);
  return [...models.values()];
}

function configOptions(result: unknown): Record<string, unknown>[] {
  return array(record(result).configOptions).map(record);
}
function selectOptions(
  config: Record<string, unknown>,
): { value: string; label: string }[] {
  return array(config.options).flatMap((raw) => {
    const item = record(raw);
    if (Array.isArray(item.options)) return selectOptions(item);
    return typeof item.value === "string"
      ? [{ value: item.value, label: String(item.name ?? item.value) }]
      : [];
  });
}

export function kimiModels(result: unknown): RuntimeModelOption[] {
  const configs = configOptions(result);
  const model = configs.find((c) => c.category === "model" || c.id === "model");
  const thinking = configs.find(
    (c) => c.category === "thought_level" || c.id === "thinking",
  );
  if (model)
    return selectOptions(model).map((option) => ({
      id: option.value,
      label: option.label,
      isDefault: option.value === model.currentValue,
      // ACP describes thinking for the currently selected model only.
      ...(option.value === model.currentValue
        ? {
            reasoningOptions: thinking ? selectOptions(thinking) : [],
            defaultReasoningEffort:
              typeof thinking?.currentValue === "string"
                ? thinking.currentValue
                : undefined,
            reasoningConfigId:
              typeof thinking?.id === "string" ? thinking.id : undefined,
          }
        : {}),
    }));
  const legacy = record(record(result).models);
  return array(legacy.availableModels).flatMap((raw) => {
    const item = record(raw);
    return typeof item.modelId === "string"
      ? [
          {
            id: item.modelId,
            label: String(item.name ?? item.modelId),
            isDefault: item.modelId === legacy.currentModelId,
          },
        ]
      : [];
  });
}

export function validateRuntimeModel(
  models: RuntimeModelOption[],
  selection: RuntimeModelSelection,
): RuntimeModelOption {
  const model = models.find((model) => model.id === selection.modelId);
  if (!model)
    throw new Error(`Model is no longer available: ${selection.modelId}`);
  if (
    selection.reasoningEffort &&
    !model.reasoningOptions?.some(
      (option) => option.value === selection.reasoningEffort,
    )
  ) {
    throw new Error(
      `Unsupported reasoning option for ${model.label}: ${selection.reasoningEffort}`,
    );
  }
  return model;
}

/** A model switch must settle before reading/applying its thinking options. */
export async function selectKimiModel(
  rpc: ModelRpc,
  sessionId: string,
  state: unknown,
  selection: RuntimeModelSelection,
  onState?: (state: unknown) => void,
): Promise<unknown> {
  validateRuntimeModel(kimiModels(state), { modelId: selection.modelId });
  const modelConfig = configOptions(state).find(
    (c) => c.category === "model" || c.id === "model",
  );
  let next = state;
  if (!modelConfig || modelConfig.currentValue !== selection.modelId) {
    next = modelConfig
      ? await rpc.request("session/set_config_option", {
          sessionId,
          configId: modelConfig.id,
          value: selection.modelId,
        })
      : await rpc.request("session/set_model", {
          sessionId,
          modelId: selection.modelId,
        });
    onState?.(next);
  }
  // Legacy set_model may not return a catalog; it cannot expose effort controls.
  if (!modelConfig && !configOptions(next).length) {
    if (selection.reasoningEffort)
      throw new Error("This Kimi CLI does not report thinking options");
    return state;
  }
  const inheritedThinking = configOptions(next).find(
    (c) => c.category === "thought_level" || c.id === "thinking",
  );
  const inheritedOptions = inheritedThinking
    ? selectOptions(inheritedThinking)
    : [];
  // Kimi Code 0.40.1 appends the previous model's current value to the new
  // catalog, even when its setter rejects that value. Reapplying it resolves
  // aliases (e.g. K3's "on") and returns the model's canonical options.
  if (
    inheritedOptions.some((option) => option.value === "on") &&
    inheritedOptions.some((option) => !["off", "on"].includes(option.value)) &&
    typeof inheritedThinking?.currentValue === "string"
  ) {
    const setThinking = (value: string) =>
      rpc.request("session/set_config_option", {
        sessionId,
        configId: inheritedThinking.id,
        value,
      });
    try {
      next = await setThinking(inheritedThinking.currentValue);
    } catch (error) {
      // Only this explicit invalid-value response permits a boolean fallback.
      // Transport/auth/model failures must not change the requested effort.
      if (
        record(error).code !== -32602 ||
        !String(record(error).message).includes("Unknown thinking value:") ||
        inheritedOptions.some(
          (option) =>
            !["off", "on", inheritedThinking.currentValue].includes(
              option.value,
            ),
        )
      )
        throw error;
      next = await setThinking("on");
    }
    onState?.(next);
  }
  const currentModel = validateRuntimeModel(kimiModels(next), {
    modelId: selection.modelId,
  });
  const effort =
    selection.reasoningEffort === inheritedThinking?.currentValue &&
    !currentModel.reasoningOptions?.some(
      (option) => option.value === selection.reasoningEffort,
    )
      ? currentModel.defaultReasoningEffort
      : selection.reasoningEffort;
  const model = validateRuntimeModel(kimiModels(next), {
    ...selection,
    reasoningEffort: effort,
  });
  if (effort && model.reasoningConfigId) {
    next = await rpc.request("session/set_config_option", {
      sessionId,
      configId: model.reasoningConfigId,
      value: effort,
    });
    onState?.(next);
  }
  return next;
}

export function codexModelParams(
  selection?: RuntimeModelSelection,
): Record<string, unknown> {
  return selection
    ? {
        model: selection.modelId,
        ...(selection.reasoningEffort
          ? { effort: selection.reasoningEffort }
          : {}),
      }
    : {};
}

/** Choose only controls actually advertised by the selected runtime model. */
export function lowestRuntimeSelection(
  model: RuntimeModelOption,
): RuntimeModelSelection {
  const order = [
    "none",
    "off",
    "disabled",
    "false",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "on",
    "enabled",
    "true",
  ];
  const options = [...(model.reasoningOptions ?? [])];
  options.sort((a, b) => {
    const rank = (v: string) => {
      const i = order.indexOf(v.toLowerCase());
      return i < 0 ? 100 : i;
    };
    return rank(a.value) - rank(b.value);
  });
  return {
    modelId: model.id,
    reasoningEffort: options[0]?.value ?? model.defaultReasoningEffort,
  };
}
