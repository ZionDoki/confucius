import { taskTemplate, type ResearchTaskRecord } from "@confucius/protocol";

interface TaskPresetState {
  record: ResearchTaskRecord;
  loadedSkills: Set<string>;
  activeTurnId: string | null;
}

/** A preset is task state; clearing it must also stop implicit skill loading. */
export async function setTaskPreset(
  state: TaskPresetState,
  templateId: unknown,
  persist: () => Promise<void>,
): Promise<ResearchTaskRecord> {
  const template = taskTemplate(templateId);
  if (templateId !== null && !template)
    throw new Error("Unknown task template");
  if (
    state.activeTurnId ||
    state.record.status === "running" ||
    state.record.status === "awaiting_approval"
  )
    throw new Error(
      "Wait for the running research to finish before changing its preset",
    );

  const previous = {
    templateId: state.record.templateId,
    updatedAt: state.record.updatedAt,
    loadedSkills: state.loadedSkills,
  };
  const previousTemplate = taskTemplate(previous.templateId);
  state.loadedSkills = new Set(previous.loadedSkills);
  if (
    previousTemplate?.skillSlug &&
    previousTemplate.skillSlug !== template?.skillSlug
  )
    state.loadedSkills.delete(previousTemplate.skillSlug);
  if (template?.skillSlug) state.loadedSkills.add(template.skillSlug);
  if (template) state.record.templateId = template.id;
  else delete state.record.templateId;
  state.record.updatedAt = Date.now();
  try {
    await persist();
  } catch (error) {
    if (previous.templateId === undefined) delete state.record.templateId;
    else state.record.templateId = previous.templateId;
    state.record.updatedAt = previous.updatedAt;
    state.loadedSkills = previous.loadedSkills;
    throw error;
  }
  return state.record;
}
