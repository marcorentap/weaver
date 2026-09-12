import type { AgentRunContext } from "./run-agent.js";
import { loadedPlugins } from "./plugins.js";
import { getStore } from "./store.js";
import { registerPendingMedia } from "./pending-media.js";

export type AgentRuntime = Omit<AgentRunContext, "root" | "onSession">;

/** A plugin's settings, one JSON blob per plugin id under a per-plugin store
 *  key. Plugins read their own config through the `getSetting` the runner
 *  hands into tool execution, so they stay decoupled from the renderer and
 *  the app's settings shape. */
function pluginSetting(
  store: ReturnType<typeof getStore>,
  pluginId: string,
  key: string,
): string | undefined {
  const raw = store.getSetting(`weaver.plugins.${pluginId}`);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Everything a run needs that is the same for the local app and for this
 *  machine's own remote server (same process, same plugins, same store).
 *  The per-run parts — `root` and `onSession` — are supplied by the caller. */
export function buildAgentRuntime(): AgentRuntime {
  const { kinds, tools } = loadedPlugins();
  const store = getStore();
  return {
    kinds,
    pluginTools: tools,
    getSetting: (pluginId, key) => pluginSetting(store, pluginId, key),
    registerPendingMedia,
  };
}