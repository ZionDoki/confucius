import { visibleModelEvents, type ConfuciusEvent } from "@confucius/protocol";
import type { ModelMessage } from "@confucius/harness";

/** Rebuild only the retained conversation; discarded checkpoints cannot be reused. */
export function preparePromptEdit(
  events: readonly ConfuciusEvent[],
  eventId: string,
  expectedText: string,
  turnId?: string,
) {
  const matches = events.flatMap((event, index) =>
    event.id === eventId &&
    event.type === "turn_started" &&
    (turnId === undefined || event.turnId === turnId)
      ? [index]
      : [],
  );
  if (matches.length !== 1)
    throw new Error(
      "This message is no longer available. Reload the conversation.",
    );
  const index = matches[0];
  const target = events[index];
  if (!target || target.type !== "turn_started" || !target.turnId)
    throw new Error(
      "This message is no longer available. Reload the conversation.",
    );
  if (target.payload.userText !== expectedText)
    throw new Error("This message has changed. Reload it before editing.");
  const retained = events.slice(0, index);
  const messages: ModelMessage[] = [];
  for (const event of visibleModelEvents(retained)) {
    if (event.type === "turn_started")
      messages.push({ role: "user", content: event.payload.userText });
    else if (
      event.type === "text_delta" &&
      event.payload.phase !== "commentary"
    ) {
      const last = messages.at(-1);
      if (last?.role === "assistant") last.content += event.payload.text;
      else messages.push({ role: "assistant", content: event.payload.text });
    }
  }
  return {
    target,
    events: retained,
    messages,
    removedTurnIds: [
      ...new Set(
        events
          .slice(index)
          .flatMap((event) => (event.turnId ? [event.turnId] : [])),
      ),
    ],
    artifactIds: [
      ...new Set(
        retained.flatMap((event) =>
          event.type === "artifact_upserted" ? [event.payload.artifact.id] : [],
        ),
      ),
    ],
  };
}

/** Attachment bodies are recovered from the host archive, never supplied by the editor. */
export function attachmentReplayText(inputs: string[]): string {
  const marker = "\n\n<confucius_read_only_attachments>\n";
  for (const input of inputs) {
    const start = input.indexOf(marker);
    if (start >= 0 && input.endsWith("</confucius_read_only_attachments>"))
      return input.slice(start);
  }
  throw new Error(
    "The original attachment text is no longer available. Send a new message with the files attached.",
  );
}
