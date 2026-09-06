import { ipcMain } from "electron";
import type { Plugin } from "@repo/plugins";
import { loadedPlugins } from "../lib/plugins.js";

/**
 * A plugin's shape across the IPC boundary. Settings carry no functions
 * (Electron's structured clone cannot send them), and none of the description
 * fields a plugin writes need to be a live callback; validation of plugin
 * setting values happens main-side when the value is used. What remains is
 * everything the renderer needs to render a plugin's Settings section.
 */
type SerializablePlugin = {
  id: string;
  name: string;
  description: string;
  settings?: Plugin["settings"];
};

function serializable(plugin: Plugin): SerializablePlugin {
  // Drop the `validate` callback from every setting field, leaving the
  // rest (kind, key, label, description, options, step range) intact.
  const settings = plugin.settings?.map((field) => {
    if (field.kind === "string") return { ...field, validate: undefined };
    return field;
  });
  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    settings,
  };
}

/** Tell the renderer which plugins are loaded and where from, so its
 *  Settings page can open one section per plugin and edit each plugin's
 *  own settings. */
export function registerPluginHandlers(): void {
  ipcMain.handle("plugins:list", () => {
    const { dir, plugins } = loadedPlugins();
    return { dir, plugins: plugins.map(serializable) };
  });
}