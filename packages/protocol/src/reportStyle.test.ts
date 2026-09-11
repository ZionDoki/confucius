import assert from "node:assert/strict";
import { it } from "node:test";
import {
  DEFAULT_REPORT_STYLE,
  REPORT_STYLE_OPTIONS,
  isReportStyle,
  reportStyleGuidance,
  restoreReportStyle,
} from "./reportStyle";
import { migrateSessionRecord } from "./session";

it("validates every independent combination without accepting incomplete preferences", () => {
  for (const layout of REPORT_STYLE_OPTIONS.layout)
    for (const tone of REPORT_STYLE_OPTIONS.tone)
      for (const focus of REPORT_STYLE_OPTIONS.focus) {
        const style = { layout, tone, focus };
        assert.ok(isReportStyle(style));
        const instruction = reportStyleGuidance(style);
        assert.match(
          instruction,
          new RegExp(`layout=${layout}; tone=${tone}; focus=${focus}`),
        );
        assert.match(instruction, /EVERY combination/);
        assert.match(instruction, /essential reasoning/);
        assert.match(instruction, /:::details/);
      }
  for (const invalid of [
    null,
    [],
    "essay",
    {},
    { ...DEFAULT_REPORT_STYLE, layout: "grid" },
    { layout: "essay", tone: "patient" },
  ])
    assert.equal(restoreReportStyle(invalid), undefined);
  const input = { ...DEFAULT_REPORT_STYLE, extra: "ignored" };
  assert.deepEqual(restoreReportStyle(input), DEFAULT_REPORT_STYLE);
  assert.notEqual(restoreReportStyle(input), input);
});

it("restores saved preferences across engine changes without prompting migrated tasks silently", () => {
  const base = migrateSessionRecord({
    id: "t",
    title: "Paper",
    createdAt: 1,
    updatedAt: 1,
    mode: "agent",
    context: {},
    permissionMode: "ask",
  });
  assert.equal(base.reportStyle, undefined);
  for (const backend of ["native", "codex", "kimi"] as const) {
    const restored = migrateSessionRecord(
      JSON.parse(
        JSON.stringify({ ...base, backend, reportStyle: DEFAULT_REPORT_STYLE }),
      ),
    );
    assert.deepEqual(restored.reportStyle, DEFAULT_REPORT_STYLE);
    assert.equal(restored.backend, backend);
  }
  const damaged = migrateSessionRecord({
    ...base,
    reportStyle: { layout: "invalid" },
  } as never);
  assert.equal(damaged.reportStyle, undefined);
});
