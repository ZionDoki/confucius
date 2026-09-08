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

/** Reproduces the advertised values and setter behavior in Kimi Code 0.40.1. */
function kimi0401() {
  let modelId = "k3";
  let value = "high";
  const calls: [string, Record<string, unknown>][] = [];
  const state = () => {
    const result = acpState(modelId, value);
    result.configOptions[0].options.push({ value: "k2-fast", name: "K2 Fast" });
    const values = modelId === "k3" ? ["low", "high", "max"] : ["on"];
    if (!values.includes(value)) values.push(value);
    result.configOptions[1].options = values.map((value) => ({
      value,
      name: value,
    }));
    return result;
  };
  return {
    state,
    calls,
    async request<T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> {
      calls.push([method, params]);
      if (params.configId === "model") {
        modelId = String(params.value);
      } else {
        const next = String(params.value);
        const supported =
          modelId === "k3" ? ["on", "low", "high", "max"] : ["on"];
        if (!supported.includes(next))
          throw Object.assign(
            new Error(`Invalid params: Unknown thinking value: ${next}`),
            {
              code: -32602,
            },
          );
        value = modelId === "k3" && next === "on" ? "max" : next;
      }
      return state() as T;
    },
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

  for (const modelId of ["k2", "k2-fast"]) {
    it(`repairs the stale high advertised after switching from K3 to ${modelId}`, async () => {
      const rpc = kimi0401();
      const next = await selectKimiModel(rpc, "session", rpc.state(), {
        modelId,
      });
      const model = kimiModels(next).find((model) => model.id === modelId)!;
      assert.deepEqual(model.reasoningOptions, [{ value: "on", label: "on" }]);
      assert.equal(model.defaultReasoningEffort, "on");
      assert.deepEqual(
        rpc.calls.map(([, params]) => params.value),
        [modelId, "high", "on"],
      );
      assert.throws(
        () =>
          validateRuntimeModel([model], { modelId, reasoningEffort: "high" }),
        /Unsupported/,
      );
    });
  }

  it("resolves an already-saved stale effort to the model's confirmed value", async () => {
    const rpc = kimi0401();
    const next = await selectKimiModel(rpc, "session", rpc.state(), {
      modelId: "k2-fast",
      reasoningEffort: "high",
    });
    assert.equal(
      kimiModels(next).find((model) => model.isDefault)?.defaultReasoningEffort,
      "on",
    );
    assert.equal(rpc.calls.at(-1)?.[1].value, "on");
  });

  it("resolves K3's inherited on alias using the CLI default rather than guessing high", async () => {
    const rpc = kimi0401();
    const k2 = await selectKimiModel(rpc, "session", rpc.state(), {
      modelId: "k2",
    });
    const next = await selectKimiModel(rpc, "session", k2, { modelId: "k3" });
    const model = kimiModels(next).find((model) => model.id === "k3")!;
    assert.deepEqual(
      model.reasoningOptions?.map((option) => option.value),
      ["low", "high", "max"],
    );
    assert.equal(model.defaultReasoningEffort, "max");
    const selected = await selectKimiModel(rpc, "session", next, {
      modelId: "k3",
      reasoningEffort: "high",
    });
    assert.equal(kimiModels(selected)[0].defaultReasoningEffort, "high");
  });

  it("retains a completed model switch when the following effort selection fails", async () => {
    const rpc = kimi0401();
    let state: unknown = rpc.state();
    const update = (next: unknown) => {
      state = next;
    };
    await assert.rejects(
      selectKimiModel(
        rpc,
        "session",
        state,
        {
          modelId: "k2",
          reasoningEffort: "max",
        },
        update,
      ),
      /Unsupported/,
    );
    assert.equal(kimiModels(state).find((model) => model.isDefault)?.id, "k2");
    await selectKimiModel(
      rpc,
      "session",
      state,
      { modelId: "k3", reasoningEffort: "low" },
      update,
    );
    assert.equal(kimiModels(state)[0].defaultReasoningEffort, "low");
    assert.equal(
      rpc.calls.filter(([, params]) => params.configId === "model").length,
      2,
    );
  });

  it("does not fall back to another effort after a transport or authorization failure", async () => {
    const runtime = kimi0401();
    await runtime.request("session/set_config_option", {
      configId: "model",
      value: "k2",
    });
    for (const failure of [
      new Error("connection lost"),
      Object.assign(new Error("access denied"), { code: -32602 }),
    ]) {
      let calls = 0;
      const rpc = {
        async request<T>(): Promise<T> {
          calls++;
          throw failure;
        },
      };
      await assert.rejects(
        selectKimiModel(rpc, "session", runtime.state(), { modelId: "k2" }),
        (error) => error === failure,
      );
      assert.equal(calls, 1);
    }
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
