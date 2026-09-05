import type {
  ContextSearchItem,
  HistoryTask,
  TaskContextReference,
} from "@confucius/protocol";

export type MentionChoice = ContextSearchItem & {
  taskReference?: TaskContextReference;
};
export function taskMentionChoice(task: HistoryTask): MentionChoice {
  return {
    libraryID: 0,
    key: task.id,
    title: task.title,
    itemType: task.status,
    creators: [new Date(task.updatedAt).toLocaleString()],
    year: "",
    taskReference: { kind: "task", taskId: task.id, title: task.title },
  };
}
export function mergeTaskReferences(
  refs: TaskContextReference[],
  ref: TaskContextReference,
): TaskContextReference[] {
  return refs.some((item) => item.taskId === ref.taskId)
    ? refs
    : [...refs, ref].slice(0, 20);
}
export function composerKeyAction(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">,
  composing: boolean,
): "send" | "newline" | "ignore" | "other" {
  if (composing || event.isComposing || event.keyCode === 229) return "ignore";
  return event.key === "Enter"
    ? event.shiftKey
      ? "newline"
      : "send"
    : "other";
}
