import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  codexModels,
  codexModelParams,
  kimiModels,
  selectKimiModel,
  validateRuntimeModel,
} from "./RuntimeModels";

function acpState(modelId = "k3", value = "high") {
  return {
    configOptions: [
      {
        type: "select",
        id: "model",
        category: "model",
        currentValue: modelId,
        options: [
          { value: "k3", name: "K3" },
          { value: "k2", name: "K2" },
        ],
      },
      {
        type: "select",
        id: "thinking",
        category: "thought_level",
        currentValue: value,
        options: (modelId === "k3"
          ? ["low", "high", "max"]
          : ["off", "on"]
        ).map((value) => ({ value, name: value })),
      },
    ],
  };
}

describe("runtime model capabilities", () => {
  it("reads every Codex catalog page, including new effort IDs", async () => {
    const calls: Record<string, unknown>[] = [];
    const rpc = {
      async request<T>(
        _method: string,
        params: Record<string, unknown>,
      ): Promise<T> {
        calls.push(params);
        return (
          params.cursor
            ? {
                data: [
                  {
                    model: "custom",
                    displayName: "Custom",
                    defaultReasoningEffort: "ultra",
                    supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
                  },
                ],
                nextCursor: null,
              }
            : {
                data: [{ model: "hidden", hidden: true }],
                nextCursor: "page-2",
              }
        ) as T;
      },
    };
    const models = await codexModels(rpc);
    assert.equal(calls[1].cursor, "page-2");
    assert.deepEqual(models[0].reasoningOptions, [
      { value: "ultra", label: "ultra" },
    ]);
    assert.equal(models.length, 1);
    assert.deepEqual(
      codexModelParams({ modelId: "custom", reasoningEffort: "ultra" }),
      { model: "custom", effort: "ultra" },
    );
    assert.throws(
      () =>
        validateRuntimeModel(models, {
          modelId: "custom",
          reasoningEffort: "low",
        }),
      /Unsupported/,
    );
  });

  it("does not reuse Kimi current-model thinking options for another model", () => {
    const models = kimiModels(acpState());
    assert.deepEqual(
      models[0].reasoningOptions?.map((option) => option.value),
      ["low", "high", "max"],
    );
    assert.equal(models[1].reasoningOptions, undefined);
  });

  it("waits for a Kimi model change before applying its own thought option", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const rpc = {
      async request<T>(
        method: string,
        params: Record<string, unknown>,
      ): Promise<T> {
        calls.push([method, params]);
        return acpState(
          "k2",
          params.configId === "thinking" ? String(params.value) : "on",
        ) as T;
      },
    };
    const next = await selectKimiModel(rpc, "session-1", acpState(), {
      modelId: "k2",
      reasoningEffort: "off",
    });
    assert.deepEqual(calls, [
      [
        "session/set_config_option",
        { sessionId: "session-1", configId: "model", value: "k2" },
      ],
      [
        "session/set_config_option",
        { sessionId: "session-1", configId: "thinking", value: "off" },
      ],
    ]);
    assert.equal(kimiModels(next)[1].defaultReasoningEffort, "off");
    calls.length = 0;
    await assert.rejects(
      selectKimiModel(rpc, "session-1", acpState(), {
        modelId: "k2",
        reasoningEffort: "max",
      }),
      /Unsupported/,
    );
    assert.equal(calls.length, 1, "never send a fabricated thinking value");
  });

  it("surfaces failed Kimi selection and does not proceed to thinking", async () => {
    const rpc = {
      async request<T>(): Promise<T> {
        throw new Error("model unavailable");
      },
    };
    await assert.rejects(
      selectKimiModel(rpc, "s", acpState(), {
        modelId: "k2",
        reasoningEffort: "on",
      }),
      /model unavailable/,
    );
  });

  it("supports legacy ACP model IDs without making up thought levels", async () => {
    const state = {
      models: {
        currentModelId: "old",
        availableModels: [{ modelId: "old", name: "Old CLI model" }],
      },
    };
    const calls: string[] = [];
    const rpc = {
      async request<T>(method: string): Promise<T> {
        calls.push(method);
        return {} as T;
      },
    };
    await selectKimiModel(rpc, "s", state, { modelId: "old" });
    assert.deepEqual(calls, ["session/set_model"]);
    assert.equal(kimiModels(state)[0].reasoningOptions, undefined);
    await assert.rejects(
      selectKimiModel(rpc, "s", state, {
        modelId: "old",
        reasoningEffort: "high",
      }),
      /does not report/,
    );
  });
});
