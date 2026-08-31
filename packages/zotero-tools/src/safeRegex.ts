/**
 * Guards for model-supplied regular expressions. JS RegExp has no timeout,
 * so catastrophic backtracking cannot be interrupted — instead we reject
 * the patterns that enable it (a quantifier applied to a group that itself
 * contains a quantifier) and cap everything else. Detection is heuristic:
 * false negatives are possible, false positives just ask the model to
 * simplify its pattern.
 */

const MAX_PATTERN_LENGTH = 160;
const MAX_SEARCH_CHARS = 500_000;
const INNERMOST_GROUP = /\((?:\\.|[^()\\])*\)/;

/**
 * True when a quantified group's body itself contains a quantifier (possibly
 * through nesting): `(a+)+`, `((a|b)*)+`, `(a{2,3})*`. Collapses innermost
 * groups one level per pass so nesting depth does not hide the pattern.
 */
function hasNestedQuantifier(pattern: string): boolean {
  let source = pattern;
  for (let depth = 0; depth < 8; depth++) {
    const match = INNERMOST_GROUP.exec(source);
    if (!match) {
      return false;
    }
    const body = match[0].slice(1, -1);
    const after = source.slice(match.index + match[0].length);
    if (/^[+*{]/.test(after) && /[+*{]/.test(body)) {
      return true;
    }
    source =
      source.slice(0, match.index) + "G" + source.slice(match.index + match[0].length);
  }
  return false;
}

export type SafeRegexResult =
  | { ok: true; regex: RegExp; subject: string }
  | { ok: false; reason: string };

export function compileSafeRegex(
  pattern: string,
  subject: string,
  flags = "gi",
): SafeRegexResult {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      reason: `Pattern longer than ${MAX_PATTERN_LENGTH} characters; simplify it`,
    };
  }
  if (hasNestedQuantifier(pattern)) {
    return {
      ok: false,
      reason:
        "Pattern contains nested quantifiers that can hang the engine; rewrite it (e.g. split into two searches)",
    };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    return { ok: false, reason: "Invalid regular expression" };
  }
  return { ok: true, regex, subject: subject.slice(0, MAX_SEARCH_CHARS) };
}

/**
 * Collect matches with a hard cap, immune to both runaway hit counts and
 * zero-length-match infinite loops.
 */
export function collectMatches(
  regex: RegExp,
  subject: string,
  maxHits: number,
): Array<{ index: number; snippet: string }> {
  const hits: Array<{ index: number; snippet: string }> = [];
  let match: RegExpExecArray | null;
  let guard = 0;
  const maxSteps = Math.min(subject.length + 10, 5_000_000);
  while ((match = regex.exec(subject)) !== null && hits.length < maxHits) {
    if (guard++ > maxSteps) {
      break;
    }
    const index = match.index;
    hits.push({
      index,
      snippet: subject.slice(Math.max(0, index - 80), index + 160),
    });
    if (match[0] === "") {
      // Empty match: advance manually or exec loops forever.
      regex.lastIndex = index + 1;
      if (index + 1 >= subject.length) {
        break;
      }
    }
  }
  return hits;
}
