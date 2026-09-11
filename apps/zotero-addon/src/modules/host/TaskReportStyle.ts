import {
  restoreReportStyle,
  type ResearchTaskRecord,
} from "@confucius/protocol";

export async function setTaskReportStyle(
  state: { record: ResearchTaskRecord; activeTurnId: string | null },
  input: unknown,
  persist: () => Promise<void>,
): Promise<ResearchTaskRecord> {
  if (state.record.templateId !== "deep-read")
    throw new Error(
      "Report preferences are only available for paper reading tasks",
    );
  const style = restoreReportStyle(input);
  if (!style) throw new Error("Invalid reading report preferences");
  if (
    state.activeTurnId ||
    ["running", "awaiting_approval"].includes(state.record.status)
  )
    throw new Error(
      "Wait for the research to stop before changing report preferences",
    );
  const previous = state.record.reportStyle;
  const updatedAt = state.record.updatedAt;
  state.record.reportStyle = style;
  state.record.updatedAt = Date.now();
  try {
    await persist();
  } catch (error) {
    state.record.reportStyle = previous;
    state.record.updatedAt = updatedAt;
    throw error;
  }
  return state.record;
}
