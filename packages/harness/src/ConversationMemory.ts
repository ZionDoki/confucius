import type { ModelAdapter, ModelMessage } from "./ModelAdapter";

export interface CompactionResult {
  /** Compacted history without the system message. */
  messages: ModelMessage[];
  compacted: boolean;
}

export function estimateChars(messages: ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += message.content.length;
    for (const call of message.toolCalls ?? []) {
      total += JSON.stringify(call.args ?? {}).length;
    }
  }
  return total;
}

export function needsCompaction(
  messages: ModelMessage[],
  maxChars: number,
): boolean {
  return estimateChars(messages) > maxChars;
}

const SUMMARY_PROMPT = [
  "Summarize this earlier conversation for future context.",
  "Preserve: the user's goals and constraints, decisions made, papers and items",
  "discussed (cite as libraryID:key), search results that mattered, findings,",
  "and pending actions. Drop small talk and redundant tool output.",
  "The full transcript remains in searchable conversation logs; this summary is",
  "only for in-context continuity. Reply with the summary only, at most 300 words.",
].join(" ");

/**
 * Compact a conversation history that exceeds `maxChars` by summarizing the
 * older prefix with the model and keeping the recent tail verbatim. The
 * summary becomes the first message of the compacted history. Bounded to
 * three summarization rounds so a chatty model cannot loop forever.
 */
export async function compactHistory(
  model: ModelAdapter,
  messages: ModelMessage[],
  maxChars: number,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  let current = messages.slice();
  for (
    let round = 0;
    round < 3 && needsCompaction(current, maxChars);
    round++
  ) {
    const tailChars = tailLengthWithinBudget(current, Math.floor(maxChars / 2));
    const prefix = current.slice(0, current.length - tailChars);
    const tail = current.slice(current.length - tailChars);
    if (prefix.length === 0) {
      break;
    }
    const summary = await summarize(model, prefix, signal);
    const summaryMessage: ModelMessage = {
      role: "user",
      content: `[Earlier conversation summary]\n${summary}`,
    };
    current = [summaryMessage, ...tail];
    if (summary.length === 0) {
      break;
    }
  }
  return { messages: current, compacted: current.length !== messages.length };
}

function tailLengthWithinBudget(
  messages: ModelMessage[],
  budgetChars: number,
): number {
  let chars = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = estimateChars([messages[i]]);
    if (count > 0 && chars + size > budgetChars) {
      break;
    }
    chars += size;
    count += 1;
    // Keep the tail anchored on a user or assistant message, never a lone
    // tool result that would dangle without its assistant tool_calls.
    if (
      count >= 4 &&
      count < messages.length &&
      messages[i - 1]?.role !== "tool"
    ) {
      break;
    }
  }
  return Math.max(count, Math.min(messages.length, 1));
}

async function summarize(
  model: ModelAdapter,
  messages: ModelMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const transcript = messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n\n")
    .slice(0, 60_000);
  const turn = await model.complete(
    {
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: transcript },
      ],
    },
    signal,
  );
  return (turn.text ?? "").trim();
}
