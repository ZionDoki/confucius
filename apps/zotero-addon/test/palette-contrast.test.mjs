import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import test from "node:test";

const stylesheet = readFileSync(
  new URL("../addon/content/workspacePalette.css", import.meta.url),
  "utf8",
);
const [light, dark] = stylesheet.split("@media");

function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/i);
  const linear = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

for (const [name, block] of Object.entries({ light, dark })) {
  const colors = Object.fromEntries(
    [...block.matchAll(/--confucius-([\w-]+):\s*(#[\da-f]{6});/gi)].map(
      ([, key, value]) => [key, value],
    ),
  );
  const check = (foreground, background, minimum) => {
    const values = [colors[foreground], colors[background]]
      .map(luminance)
      .sort((a, b) => a - b);
    const ratio = (values[1] + 0.05) / (values[0] + 0.05);
    assert.ok(
      ratio >= minimum,
      `${name}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1; expected ${minimum}:1`,
    );
  };

  test(`${name} theme keeps small text readable on resting, hovered and selected surfaces`, () => {
    for (const background of [
      "paper",
      "elevated",
      "surface",
      "hover",
      "selected",
    ]) {
      for (const foreground of [
        "ink",
        "secondary",
        "muted",
        "accent",
        "accent-text",
        "danger",
        "success",
      ]) {
        check(foreground, background, 4.5);
      }
      check("focus", background, 3);
    }
    for (const background of ["primary", "primary-hover"]) {
      check("primary-ink", background, 4.5);
    }
    check("selection-ink", "selection", 4.5);
  });

  test(`${name} theme keeps status messages and thin scrollbars visible`, () => {
    check("success", "success-surface", 4.5);
    check("danger", "danger-surface", 4.5);
    check("accent-text", "warning-surface", 4.5);
    for (const background of ["paper", "elevated", "surface"]) {
      check("scrollbar", background, 3);
      check("scrollbar-hover", background, 3);
    }
  });
}
