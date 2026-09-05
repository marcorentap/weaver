import { ipcMain } from "electron";
import { getStore } from "../lib/store.js";

/**
 * Renderer preferences (appearance, AI provider), stored as one opaque
 * key/value row per key. The main process validates nothing about the
 * value's shape; that's the renderer's concern.
 */
export function registerSettingsHandlers(): void {
  ipcMain.handle("settings:get", (_event, key: string) => {
    return getStore().getSetting(key) ?? null;
  });

  ipcMain.handle("settings:set", (_event, key: string, value: string) => {
    getStore().setSetting(key, value);
  });
}
