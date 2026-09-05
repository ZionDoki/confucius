import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_UI_LINE_HEIGHT,
  clampMaxIterations,
  clampMaxToolCalls,
  isUiLanguage,
  isUiTheme,
  isUiLineHeight,
  RPC_METHODS,
  UI_LINE_HEIGHT_VALUES,
  validateConfigPatch,
} from "./rpc";

describe("validateConfigPatch", () => {
  it("accepts supported appearance choices and rejects invalid themes", () => {
    for (const theme of ["auto", "light", "dark"]) {
      assert.equal(isUiTheme(theme), true);
      assert.equal(validateConfigPatch({ uiTheme: theme }).ok, true);
    }
    assert.equal(validateConfigPatch({ uiTheme: "night" }).ok, false);
    assert.equal(isUiTheme(null), false);
  });
  it("accepts a valid patch", () => {
    const result = validateConfigPatch({
      baseUrl: "http://172.30.111.252:54321/api/chat",
      apiKey: "ollama",
      model: "qwen3.8-27b:latest",
      maxTokens: 0,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(
        result.value.baseUrl,
        "http://172.30.111.252:54321/api/chat",
      );
      assert.equal(result.value.model, "qwen3.8-27b:latest");
    }
  });

  it("rejects non-http base URLs and malformed URLs", () => {
    assert.equal(validateConfigPatch({ baseUrl: "ftp://x" }).ok, false);
    assert.equal(validateConfigPatch({ baseUrl: "http://" }).ok, false);
  });

  it("rejects an empty model and negative or fractional max tokens", () => {
    assert.equal(validateConfigPatch({ model: "  " }).ok, false);
    assert.equal(validateConfigPatch({ maxTokens: -1 }).ok, false);
    assert.equal(validateConfigPatch({ maxTokens: 1.5 }).ok, false);
  });

  it("allows an empty api key (local servers do not need one)", () => {
    const result = validateConfigPatch({ apiKey: "" });
    assert.equal(result.ok, true);
  });

  it("exposes config RPC methods", () => {
    assert.equal(RPC_METHODS.configGet, "config/get");
    assert.equal(RPC_METHODS.configSet, "config/set");
    assert.equal(RPC_METHODS.configListModels, "config/listModels");
  });

  it("accepts global budget fields and rejects out-of-range values", () => {
    assert.equal(
      validateConfigPatch({ maxIterations: 128, maxToolCalls: 96 }).ok,
      true,
    );
    assert.equal(validateConfigPatch({ maxIterations: 0 }).ok, false);
    assert.equal(validateConfigPatch({ maxToolCalls: 0 }).ok, false);
    assert.equal(validateConfigPatch({ maxIterations: 201 }).ok, false);
  });

  it("validates the three-state memory consent", () => {
    assert.equal(validateConfigPatch({ memoryConsent: "review" }).ok, true);
    assert.equal(validateConfigPatch({ memoryConsent: "silent" }).ok, false);
  });
});

describe("budget clamps", () => {
  it("falls back to the raised defaults", () => {
    assert.equal(clampMaxIterations(undefined), DEFAULT_MAX_ITERATIONS);
    assert.equal(clampMaxToolCalls(""), DEFAULT_MAX_TOOL_CALLS);
    assert.equal(DEFAULT_MAX_ITERATIONS, 128);
    assert.equal(DEFAULT_MAX_TOOL_CALLS, 96);
  });
});

describe("workspace appearance presets", () => {
  it("supports explicit Chinese and English interface languages", () => {
    assert.equal(isUiLanguage("zh-CN"), true);
    assert.equal(isUiLanguage("en-US"), true);
    assert.equal(isUiLanguage("fr-FR"), false);
  });

  it("keeps the current line height as the standard midpoint", () => {
    assert.equal(DEFAULT_UI_LINE_HEIGHT, "standard");
    assert.deepEqual(UI_LINE_HEIGHT_VALUES, {
      compact: 1.45,
      standard: 1.6,
      relaxed: 1.75,
    });
    assert.equal(isUiLineHeight("relaxed"), true);
    assert.equal(isUiLineHeight("wide"), false);
  });
});
