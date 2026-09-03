export interface ThinkTaggedContent {
  text: string;
  reasoning: string;
}

/**
 * Separates providers that encode reasoning inside content as
 * `<think>...</think>`. The parser keeps a short suffix between pushes so
 * tags may be split at any byte-stream chunk boundary.
 */
export class ThinkTagStreamParser {
  private pending = "";
  private inReasoning = false;

  push(piece: string): ThinkTaggedContent {
    if (!piece) return emptyContent();
    this.pending += piece;
    const output = emptyContent();

    while (this.pending) {
      const tag = this.inReasoning ? "</think>" : "<think>";
      const index = this.pending.toLowerCase().indexOf(tag);
      if (index >= 0) {
        this.append(output, this.pending.slice(0, index));
        this.pending = this.pending.slice(index + tag.length);
        this.inReasoning = !this.inReasoning;
        continue;
      }

      const held = matchingTagPrefixSuffix(this.pending, tag);
      const readyLength = this.pending.length - held;
      this.append(output, this.pending.slice(0, readyLength));
      this.pending = this.pending.slice(readyLength);
      break;
    }

    return output;
  }

  finish(): ThinkTaggedContent {
    const output = emptyContent();
    this.append(output, this.pending);
    this.pending = "";
    return output;
  }

  private append(output: ThinkTaggedContent, value: string): void {
    if (this.inReasoning) output.reasoning += value;
    else output.text += value;
  }
}

export function splitThinkTaggedContent(content: string): ThinkTaggedContent {
  const parser = new ThinkTagStreamParser();
  const first = parser.push(content);
  const tail = parser.finish();
  return {
    text: first.text + tail.text,
    reasoning: first.reasoning + tail.reasoning,
  };
}

function matchingTagPrefixSuffix(value: string, tag: string): number {
  const lower = value.toLowerCase();
  const max = Math.min(lower.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (lower.slice(-length) === tag.slice(0, length)) return length;
  }
  return 0;
}

function emptyContent(): ThinkTaggedContent {
  return { text: "", reasoning: "" };
}
