/**
 * Web search via DuckDuckGo's no-JS HTML frontend. No API key, no dependency
 * on an auth broker or credential store. Modeled on omp's
 * `DuckDuckGoProvider` (packages/coding-agent/src/web/search/providers/duckduckgo.ts
 * in github.com/can1357/oh-my-pi), trimmed to what a single stateless request
 * needs. The locale and pagination handling that provider carries for its
 * own multi-provider fallback chain is not worth reproducing here.
 */

const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_NUM_RESULTS = 8;
const MAX_NUM_RESULTS = 20;

/** Static desktop Chrome fingerprint. DuckDuckGo's HTML endpoint blocks
 *  requests with no browser-shaped headers at all; it does not require a
 *  rotating fingerprint for a handful of requests per run. */
const BROWSER_HEADERS: Record<string, string> = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export type WebSearchRecency = "day" | "week" | "month" | "year";

export interface WebSearchOptions {
  /** Number of results to return, clamped to [1, 20]. Default 8. */
  limit?: number;
  /** Time-window filter; DuckDuckGo's `df` form field. */
  recency?: WebSearchRecency;
  signal?: AbortSignal;
}

const RECENCY_TO_DDG_DF: Record<WebSearchRecency, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

/** Strip tags/entities out of a fragment lifted from DDG markup. */
function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** DDG routes result links through `//duckduckgo.com/l/?uddg=<encoded>` for
 *  click analytics; unwrap back to the real target. */
function unwrapResultUrl(href: string): string | undefined {
  if (!href) return undefined;
  const decoded = href.replace(/&amp;/gi, "&");
  const wrapped = /[?&]uddg=([^&]+)/.exec(decoded);
  if (wrapped) {
    try {
      return decodeURIComponent(wrapped[1]!);
    } catch {
      return undefined;
    }
  }
  if (decoded.startsWith("//")) return `https:${decoded}`;
  if (decoded.startsWith("http://") || decoded.startsWith("https://"))
    return decoded;
  return undefined;
}

function parseHtmlResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockRe =
    /<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
  const titleRe =
    /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRe =
    /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
  for (const match of html.matchAll(blockRe)) {
    const block = match[1]!;
    const title = titleRe.exec(block);
    if (!title) continue;
    const url = unwrapResultUrl(title[1]!);
    if (!url) continue;
    const titleText = decodeHtmlText(title[2]!);
    if (!titleText) continue;
    const snippet = snippetRe.exec(block);
    results.push({
      title: titleText,
      url,
      snippet: snippet ? decodeHtmlText(snippet[1]!) : undefined,
    });
  }
  return results;
}

/** `true` when DDG served its bot-challenge modal instead of real results. */
function isAnomalyResponse(html: string): boolean {
  return html.includes("anomaly-modal") || html.includes("anomaly.js");
}

/**
 * Run a DuckDuckGo web search and return parsed results. Throws with a
 * user-facing message on transport failure, HTTP error, or bot-detection
 * block. Callers surface that as the tool's failure text.
 */
export async function searchDuckDuckGo(
  query: string,
  options: WebSearchOptions = {},
): Promise<WebSearchResult[]> {
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_NUM_RESULTS)),
    MAX_NUM_RESULTS,
  );
  const form = new URLSearchParams({ q: query, kl: "us-en", b: "" });
  const df = options.recency ? RECENCY_TO_DDG_DF[options.recency] : undefined;
  if (df) form.set("df", df);

  const response = await fetch(DUCKDUCKGO_HTML_URL, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://html.duckduckgo.com/",
    },
    body: form.toString(),
    signal: options.signal,
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`DuckDuckGo HTML error (${response.status})`);
  }
  if (isAnomalyResponse(body)) {
    throw new Error(
      "DuckDuckGo blocked the request with a bot-detection challenge (common from datacenter IPs). Try again shortly.",
    );
  }

  return parseHtmlResults(body).slice(0, limit);
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
