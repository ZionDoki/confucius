import { requestFulltext } from "./LiteratureNetwork";
import { LiteratureError } from "./OpenAlexClient";

export async function tavilySearch(
  query: string,
  key: string,
  signal: AbortSignal,
) {
  if (!key)
    throw new LiteratureError(
      "authentication",
      "Tavily Key 未配置 / Tavily key is not configured",
    );
  const response = await requestFulltext(
    "https://api.tavily.com/search",
    signal,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 8,
        include_answer: false,
        include_raw_content: false,
      }),
      maxBytes: 2 * 1024 * 1024,
    },
  );
  let data: {
    results?: Array<{ url?: string; title?: string; content?: string }>;
  };
  try {
    data = JSON.parse(new TextDecoder().decode(response.bytes));
  } catch {
    throw new LiteratureError("network", "Invalid Tavily response");
  }
  if (!Array.isArray(data?.results))
    throw new LiteratureError("network", "Invalid Tavily results");
  return data.results
    .slice(0, 8)
    .filter((row) => row && typeof row.url === "string")
    .map((row) => ({
      url: row.url!,
      evidence: `${row.title ?? ""}\n${row.content ?? ""}`.slice(0, 800),
    }));
}
