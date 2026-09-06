import { compileSafeRegex } from "@confucius/zotero-tools";
import { deadline } from "./Deadline";
export interface RegexHit {
  index: number;
  snippet: string;
}
export interface SearchWorker {
  onmessage:
    ((event: { data: { hits?: RegexHit[]; error?: string } }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(value: unknown): void;
  terminate(): void;
}
export async function regexMatches(
  pattern: string,
  subject: string,
  signal?: AbortSignal,
  createWorker: () => SearchWorker = () => {
    if (typeof ChromeWorker === "undefined")
      throw new Error(
        "Isolated regex worker unavailable; use literal search instead",
      );
    return new ChromeWorker(
      "chrome://confucius/content/regex-worker.js",
    ) as unknown as SearchWorker;
  },
  timeoutMs = 1000,
): Promise<RegexHit[]> {
  const compiled = compileSafeRegex(pattern, subject);
  if (!compiled.ok) throw new Error(compiled.reason);
  const worker = createWorker();
  try {
    return await deadline(
      new Promise<RegexHit[]>((resolve, reject) => {
        worker.onmessage = ({ data }) =>
          data.error ? reject(new Error(data.error)) : resolve(data.hits ?? []);
        worker.onerror = (event) =>
          reject(new Error(event.message ?? "Regex worker failed"));
        worker.postMessage({ pattern, subject: compiled.subject, maxHits: 21 });
      }),
      timeoutMs,
      signal,
    );
  } finally {
    worker.terminate();
  }
}
export function literalMatches(query: string, subject: string): RegexHit[] {
  if (!query) return [];
  const needle = query.toLocaleLowerCase(),
    haystack = subject.toLocaleLowerCase();
  const hits: RegexHit[] = [];
  let offset = 0;
  while (hits.length < 21) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    hits.push({
      index,
      snippet: subject.slice(
        Math.max(0, index - 80),
        index + query.length + 120,
      ),
    });
    offset = index + Math.max(1, query.length);
  }
  return hits;
}
