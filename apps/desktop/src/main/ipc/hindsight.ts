import { ipcMain } from "electron";
import {
  connectHindsight,
  resolveBank,
  toError,
} from "@plugins/agent-hindsight";
import type { ToolRunContext } from "@repo/plugins";
import { getStore } from "../lib/store.js";
import { pluginSetting } from "../lib/agent-runtime.js";

/** Read a plugin's setting the same way a run's tool context does, so the
 *  memory menu's retain writes to the same Hindsight server and bank the
 *  agent's own `hindsight_retain` tool targets. */
const getSetting: ToolRunContext["getSetting"] = (pluginId, key) =>
  pluginSetting(getStore(), pluginId, key);

/** The chat page's memory menu: a direct, fire-and-forget retain against the
 *  configured Hindsight server, without an agent run. The renderer has no
 *  plugin-settings or network surface of its own (and must not hold the
 *  Hindsight API key), so the call happens here, where the store lives. */
export function registerHindsightHandlers(): void {
  ipcMain.handle("hindsight:retain", async (_event, content: string) => {
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "nothing to retain" };
    }
    try {
      const { client, defaultBank } = connectHindsight({ getSetting });
      const bank = resolveBank({ client, defaultBank });
      await client.retain(bank, content.trim(), { async: true });
      return { ok: true, bank };
    } catch (error) {
      return { ok: false, error: toError(error).message };
    }
  });
}