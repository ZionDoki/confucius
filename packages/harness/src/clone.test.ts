import assert from "node:assert/strict";
import test from "node:test";
import { cloneValue } from "./clone";

test("cloneValue works when structuredClone is unavailable", () => {
  const key = "structuredClone";
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  try {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: undefined,
      writable: true,
    });

    const source: { nested: { values: [number, { keep: boolean }] } } = {
      nested: { values: [1, { keep: true }] },
    };
    const copy = cloneValue(source);
    source.nested.values[1].keep = false;

    assert.notStrictEqual(copy, source);
    assert.deepEqual(copy, { nested: { values: [1, { keep: true }] } });
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});
