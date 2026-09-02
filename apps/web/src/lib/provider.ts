/**
 * An absolute provider URL for `path` under `endpoint`, or null when
 * `endpoint` is not a usable base URL. Shared by everything that talks to a
 * provider — the agent proxy, the settings check — so "what counts as a
 * valid endpoint" is answered in exactly one place, and the browser can ask
 * the same question before it ever sends a request.
 *
 * Only http(s) is accepted: a `file:` or `data:` base parses fine as a URL
 * yet is never a chat-completions provider.
 */
export function providerUrl(endpoint: string, path: string): string | null {
  const trimmed = endpoint.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/${path}`;
}
