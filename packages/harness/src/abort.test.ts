import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { abortError, errorMessage, isAbortError } from "./abort";

describe("abort helpers", () => {
  it("detects AbortError without relying on Error prototype", () => {
    assert.equal(isAbortError({ name: "AbortError" }), true);
    assert.equal(isAbortError(abortError()), true);
    assert.equal(isAbortError(new Error("nope")), false);
    assert.equal(isAbortError("Aborted"), false);
    assert.equal(isAbortError(null), false);
  });

  it("reads a message off non-Error throws", () => {
    assert.equal(errorMessage(new Error("boom")), "boom");
    assert.equal(errorMessage({ message: "xpcom" }), "xpcom");
    assert.equal(errorMessage("plain"), "plain");
    assert.equal(errorMessage({}), "Unknown error");
  });
});
