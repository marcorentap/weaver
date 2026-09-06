import { definePlugin } from "@repo/plugins";
import { webSearchTool } from "./tools/web-search/index.ts";

/**
 * Agent SearXNG: web search for the agent through a SearXNG instance. Ships
 * the `web_search` tool and the instance URL setting that configures it.
 * Blank means the tool is disabled and says so clearly.
 */
export const agentSearxng = definePlugin({
  id: "agent-seerxng",
  name: "Agent SearXNG",
  description: "Web search for the agent through a SearXNG instance.",
  settings: [
    {
      kind: "string",
      key: "searxngUrl",
      label: "SearXNG URL",
      description:
        "Base URL of a SearXNG instance used for web search. Blank disables the tool.",
      placeholder: "http://searxng-host:8085",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return null;
        let url: URL;
        try {
          url = new URL(trimmed);
        } catch {
          return "needs a scheme and host, e.g. http://searxng-host:8085";
        }
        return url.protocol === "http:" || url.protocol === "https:"
          ? (url.hostname ? null : "needs a host, e.g. http://searxng-host:8085")
          : "needs an http(s) scheme, e.g. http://searxng-host:8085";
      },
    },
  ],
  tools: [webSearchTool],
});

export default agentSearxng;

export { webSearchTool } from "./tools/web-search/index.ts";
export {
  formatWebSearchResults,
  searchSearXNG,
  type WebSearchResult,
} from "./web-search.ts";