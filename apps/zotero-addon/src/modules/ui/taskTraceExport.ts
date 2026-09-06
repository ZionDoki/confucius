import type { TaskTraceReport } from "@confucius/protocol";
import { writeRuntimeText } from "../host/RuntimeStorage";
import { renderTaskTraceHtml, taskTraceFilename } from "./taskTraceReport";

export async function exportTaskTrace(
  win: Window,
  taskId: string,
  title: string,
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<string | null> {
  const path = await new ztoolkit.FilePicker(
    title,
    "save",
    [["HTML report", "*.html"]],
    taskTraceFilename(taskId),
    win,
  ).open();
  if (!path) return null;
  const report = (await rpc("task/trace", { taskId })) as TaskTraceReport;
  if (
    report.kind !== "confucius-task-trace" ||
    report.schemaVersion !== 1 ||
    report.task.id !== taskId
  )
    throw new Error("Invalid task trace response");
  await writeRuntimeText(path, renderTaskTraceHtml(report));
  return path;
}
