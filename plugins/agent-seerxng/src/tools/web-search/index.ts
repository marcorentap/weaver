import { Type } from "typebox";
import type { PluginTool } from "@repo/plugins";
import {
  formatWebSearchResults,
  searchSearXNG,
  type WebSearchResult,
} from "../../web-search.ts";

/**
 * Web search through the SearXNG instance named in this plugin's settings.
 * Aggregates upstream engines, so no single provider's rate limit stops a
 * run. The instance URL comes from the plugin's `searxngUrl` setting, read
 * through the tool context so the tool stays decoupled from the app's store.
 */
export const webSearchTool: PluginTool = {
  name: "web_search",
  label: "Web Search",
  description:
    "Use this when you need current information you don't already have. Returns titles, URLs, and snippets from the configured SearXNG instance.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    limit: Type.Optional(
      Type.Number({
        description: "Max results to return (default 8, max 20)",
      }),
    ),
  }) as unknown as Record<string, unknown>,
  execute: async (args, ctx) => {
    const query = typeof args.query === "string" ? args.query : "";
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    // The SearXNG instance comes from the plugin's settings, read straight
    // from the store so the tool is decoupled from what the renderer
    // happens to have. Blank means no search engine is set up.
    const searxngUrl = ctx.getSetting("agent-seerxng", "searxngUrl");
    if (!searxngUrl) {
      throw new Error(
        "no SearXNG instance set: open Settings, the Agent SearXNG section, and point SearXNG URL at an instance, e.g. http://searxng-host:8085",
      );
    }
    let results: WebSearchResult[];
    try {
      results = await searchSearXNG(searxngUrl, query, { limit });
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    return {
      content: formatWebSearchResults(query, results),
      details: {},
    };
  },
};