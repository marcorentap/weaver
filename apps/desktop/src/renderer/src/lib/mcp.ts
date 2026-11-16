import { parseHeaderLines, type McpServer } from "@shared/mcp.js";
import type { McpServerSettings } from "@/lib/settings";

/**
 * The MCP servers one run should mount, from the servers the settings page
 * keeps.
 *
 * `chosen` is a custom run's own per-server decisions, keyed the same way;
 * a server it does not name keeps its saved `enabled` flag, which is what
 * makes the dialog's rows a narrowing of the saved list rather than a second
 * place servers are configured. Absent entirely — a run started with `x`
 * rather than through the dialog — the saved flags decide alone.
 *
 * A server with nothing to connect to is left out here rather than at the
 * far end: an enabled row whose command or URL is still blank is a server
 * someone is in the middle of configuring, and failing every run on it would
 * be a trap the settings page never warned about. The run's own failure is
 * kept for a server that is configured and still cannot be reached.
 */
export function mcpServersForRun(
  saved: Record<string, McpServerSettings>,
  chosen?: Record<string, boolean>,
): McpServer[] {
  const servers: McpServer[] = [];
  for (const [name, server] of Object.entries(saved)) {
    if (!(chosen?.[name] ?? server.enabled)) continue;
    if (server.transport === "http") {
      const url = server.url.trim();
      if (!url) continue;
      const headers = parseHeaderLines(server.headers);
      servers.push({
        name,
        transport: "http",
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
      continue;
    }
    const command = server.command.trim();
    if (!command) continue;
    servers.push({ name, transport: "stdio", command });
  }
  return servers;
}
