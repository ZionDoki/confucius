#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { attachIsolated } from "./lib/zotero-live.mjs";
import { renderTaskTraceHtml } from "../apps/zotero-addon/src/modules/ui/taskTraceReport.ts";
const phase = process.argv[2] ?? "final";
const report = JSON.parse(
  await readFile("output/windows-acceptance/real-engines.json", "utf8"),
);
const z = await attachIsolated(report.instance);
const evidence = { phase, at: new Date().toISOString(), engines: {} };
await mkdir("output/windows-acceptance/诊断报告", { recursive: true });
try {
  for (const [backend, e] of Object.entries(report.engines)) {
    const state = await z.rpc("task/load", { taskId: e.taskId });
    const trace = await z.rpc("task/trace", { taskId: e.taskId });
    const artifacts = await z.rpc("artifact/list", { taskId: e.taskId });
    const native = await z.rdp.evaluate(
      `const a=Zotero.Items.getByLibraryAndKey(1,${JSON.stringify(e.fixture.attachmentKey)});const p=Zotero.Items.getByLibraryAndKey(1,${JSON.stringify(e.fixture.key)});return {notes:p.getNotes(),annotations:a.getAnnotations().map(n=>({key:n.key,text:n.annotationText,comment:n.annotationComment,position:JSON.parse(n.annotationPosition)}))};`,
    );
    evidence.engines[backend] = {
      taskId: e.taskId,
      state,
      artifacts,
      native,
      traceIssues: trace.issues,
    };
    await writeFile(
      `output/windows-acceptance/诊断报告/${backend}-${phase}.json`,
      JSON.stringify(trace, null, 2),
    );
    await writeFile(
      `output/windows-acceptance/诊断报告/${backend}-${phase}.html`,
      renderTaskTraceHtml(trace),
    );
    for (const artifact of artifacts.artifacts)
      if (artifact.body?.markdown)
        await writeFile(
          `output/windows-acceptance/${backend}-${phase}-report.md`,
          artifact.body.markdown,
        );
    console.log(
      backend,
      JSON.stringify({
        status: state.status,
        window: state.contextWindow,
        budget: state.run?.budget,
        annotations: native.annotations.map((n) => n.key),
        artifacts: artifacts.artifacts.map((a) => ({
          id: a.id,
          revision: a.revision,
        })),
        issues: trace.issues,
      }),
    );
  }
  await writeFile(
    `output/windows-acceptance/evidence-${phase}.json`,
    JSON.stringify(evidence, null, 2),
  );
} finally {
  z.rdp.close();
}
