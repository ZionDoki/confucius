/**
 * Tokenizer for lexical retrieval over mixed English/Chinese memory text.
 * ASCII runs become lowercase words; CJK runs become character bigrams so
 * Chinese queries match without a segmentation dependency.
 */
const ASCII_WORD = /[a-z0-9]+/g;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens: string[] = [];
  for (const match of lowered.matchAll(ASCII_WORD)) {
    tokens.push(match[0]);
  }
  tokens.push(...cjkBigrams(lowered));
  return tokens;
}

function cjkBigrams(text: string): string[] {
  const chars: string[] = [];
  for (const char of text) {
    if (CJK.test(char)) {
      chars.push(char);
    }
  }
  const bigrams: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (i + 1 < chars.length) {
      bigrams.push(chars[i] + chars[i + 1]);
    }
    if (chars.length === 1) {
      bigrams.push(chars[i]);
    }
  }
  return bigrams;
}

export function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

/** Jaccard similarity between two texts' token sets (0..1). */
export function jaccard(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (setA.size + setB.size - intersection);
}
