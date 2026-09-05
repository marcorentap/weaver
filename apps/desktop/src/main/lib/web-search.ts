/**
 * Web search through a SearXNG instance's JSON API. SearXNG spreads queries
 * across several upstream engines, so one provider blocking the instance
 * stops being fatal, and it needs no API key. The renderer's "Search"
 * settings set the instance URL; a blank URL disables web search, and the
 * tool reports that clearly rather than failing silently.
 */

const DEFAULT_NUM_RESULTS = 8;
const MAX_NUM_RESULTS = 20;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export type WebSearchRecency = "day" | "week" | "month" | "year";

export interface WebSearchOptions {
  /** Number of results to return, clamped to [1, 20]. Default 8. */
  limit?: number;
  /** Time-window filter; SearXNG's `time_range` search param. */
  recency?: WebSearchRecency;
  signal?: AbortSignal;
}

/** SearXNG's own `time_range` values line up with ours name-for-name. */
const RECENCY_TO_TIME_RANGE: Record<WebSearchRecency, string> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

/** One SearXNG JSON result, as the field shapes we actually read. */
type SearxngResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
};

/** Pull a safe string out of a field SearXNG may send as string or null. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Run a web search against a SearXNG instance. Throws with a user-facing
 * message on transport failure, a non-2xx response, or an error the
 * instance reports in its JSON.
 */
export async function searchSearXNG(
  baseUrl: string,
  query: string,
  options: WebSearchOptions = {},
): Promise<WebSearchResult[]> {
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_NUM_RESULTS)),
    MAX_NUM_RESULTS,
  );
  const url = new URL("/search", baseUrl.replace(/\/+$/, ""));
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");
  const recency = options.recency ? RECENCY_TO_TIME_RANGE[options.recency] : undefined;
  if (recency) url.searchParams.set("time_range", recency);

  let response: Response;
  try {
    response = await fetch(url, { signal: options.signal });
  } catch (error) {
    throw new Error(
      `could not reach the search instance at ${baseUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(`SearXNG error (${response.status})`);
  }

  const payload = (await response.json()) as {
    results?: unknown;
    error?: unknown;
  };
  if (payload.error) {
    throw new Error(`SearXNG error: ${textOf(payload.error) ?? "unknown"}`);
  }
  if (!Array.isArray(payload.results)) {
    throw new Error("SearXNG returned an unexpected payload");
  }

  const results: WebSearchResult[] = [];
  for (const raw of payload.results) {
    if (typeof raw !== "object" || raw === null) continue;
    const { title, url: rawUrl, content } = raw as SearxngResult;
    const text = textOf(title);
    const href = textOf(rawUrl);
    if (!text || !href) continue;
    results.push({
      title: text,
      url: href,
      snippet: textOf(content),
    });
    if (results.length >= limit) break;
  }
  return results;
}

/** Render results as text for a tool result / LLM message. */
export function formatWebSearchResults(
  query: string,
  results: WebSearchResult[],
): string {
  if (results.length === 0) return `No results for "${query}".`;
  return results
    .map(
      (result, i) =>
        `[${i + 1}] ${result.title}\n    ${result.url}${result.snippet ? `\n    ${result.snippet}` : ""}`,
    )
    .join("\n");
}