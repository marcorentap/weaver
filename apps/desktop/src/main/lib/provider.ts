import { arch, platform, release } from "node:os";

/**
 * What weaver calls itself on the wire. Every provider request carries one,
 * and by default the transport supplies its own instead: pi-ai sends
 * `pi (<platform> <release>; <arch>)` on every completion it builds (see
 * `createClient` in its `openai-completions` API), and our own `fetch` calls
 * send node's. Neither is the app a provider's usage panel should see, so
 * the run engine overrides the header on the model it registers and
 * `image-generation.ts` names it on the image request; the shape stays pi's
 * because it is the same information, platform and architecture, from the
 * same process — only the name changes.
 */
export const WEAVER_USER_AGENT = `weaver (${platform()} ${release()}; ${arch()})`;

/**
 * An absolute provider URL for `path` under `endpoint`, or null when
 * `endpoint` is not a usable base URL. Shared by everything that talks to a
 * provider, such as the agent proxy and the settings check, so "what counts
 * as a valid endpoint" is answered in exactly one place, and the browser can
 * ask the same question before it ever sends a request.
 *
 * Only http(s) is accepted. A `file:` or `data:` base parses fine as a URL,
 * but it is never a chat-completions provider.
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
