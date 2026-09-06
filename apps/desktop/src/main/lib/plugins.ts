import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { app } from "electron";
import { coreKinds, kindRegistry, type KindRegistry } from "@repo/core";
import {
  pluginKinds,
  pluginTools,
  type Plugin,
  type PluginTool,
} from "@repo/plugins";
import type { BuildResult } from "esbuild";
import { agentSearxng } from "@plugins/agent-seerxng";
import { richMedia } from "@plugins/rich-media";
import { getStore } from "./store.js";

/**
 * Plugins bundled with the app. Their code ships inside the main bundle, so
 * they load regardless of the runtime, and the bundled registry is what the
 * store and agent actually use. The configured directory adds plugins on
 * top.
 */
const BUILT_IN: Plugin[] = [richMedia, agentSearxng];

/** Store key the configured plugin directory lives under. */
export const PLUGINS_DIR_SETTING = "weaver.plugins.dir";

/** The plugin directory when no setting is set: `~/.weaver/plugins`, next to
 *  the store. */
export function defaultPluginsDir(): string {
  return join(homedir(), ".weaver", "plugins");
}

/** Where plugin directories live, from the settings or the default. */
export function pluginsDir(): string {
  const stored = getStore().getSetting(PLUGINS_DIR_SETTING);
  return stored && stored.trim() ? stored : defaultPluginsDir();
}

export type LoadedPlugins = {
  /** Registered plugins, built-ins first, then anything else loaded from the
   *  configured dir. */
  plugins: Plugin[];
  /** The effective kind registry: core kinds plus every plugin's kinds. */
  kinds: KindRegistry;
  /** Every agent tool every plugin contributes. */
  tools: PluginTool[];
  /** The directory plugins were loaded from. */
  dir: string;
};

/** Memoized across `loadedPlugins()`/`rescanPlugins()`. */
let cached: LoadedPlugins | null = null;

function build(dir: string, plugins: Plugin[]): LoadedPlugins {
  return {
    plugins,
    kinds: kindRegistry([...coreKinds, ...pluginKinds(plugins)]),
    tools: pluginTools(plugins),
    dir,
  };
}

/**
 * Read every plugin dir's id under `dir`, in directory order. Directories
 * come back even if they fail to load later, so a bad drop-in is named in
 * the load log rather than silently never listed.
 */
function pluginDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Resolve `id` from the configured dir at runtime. The dir is an external
 * registry, so a dropped-in plugin needs no build step, unlike static module
 * loading, which cannot reach a directory the user points at.
 */
async function loadOne(id: string): Promise<Plugin | null> {
  const entry = join(pluginsDir(), id, "src", "index.ts");
  try {
    // Bundled to ESM, not imported raw: `@repo/*` packages ship raw `.ts`
    // with extensionless imports that plain Node cannot resolve, and a
    // plugin in an external directory has no node_modules of its own.
    // esbuild bundles the plugin's entry and resolves `@repo/core` and the
    // rest from the app's node_modules, so a dropped-in plugin needs no
    // build step.
    const moduleRoots = [join(app.getAppPath(), "node_modules")];
    const esbuild = await import("esbuild");
    const built = (await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "esnext",
      nodePaths: moduleRoots,
      write: false,
    })) as BuildResult;
    const code = built.outputFiles?.[0]?.text;
    if (!code) return null;
    const mod = await import("data:text/javascript," + encodeURIComponent(code));
    const plugin = (mod.default ?? mod) as Plugin | undefined;
    if (plugin && typeof plugin.id === "string" && plugin.id) return plugin;
    return null;
  } catch (error) {
    console.warn(
      `plugin "${id}" at ${entry} failed to load:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * Load every plugin, built-ins first, then runtime plugins from the
 * configured directory, computing the registries they form. Loads once and
 * memoizes; call `rescanPlugins` to reload after the directory changes.
 */
export async function ensurePluginsLoaded(
  dir: string = pluginsDir(),
): Promise<LoadedPlugins> {
  if (cached && cached.dir === dir) return cached;

  const byId = new Map<string, Plugin>();
  for (const plugin of BUILT_IN) byId.set(plugin.id, plugin);

  // Runtime extras, each loaded independently so one broken plugin never
  // silences the rest.
  const extras: Plugin[] = [];
  for (const id of pluginDirs(dir)) {
    if (byId.has(id)) continue;
    const plugin = await loadOne(id);
    if (plugin) extras.push(plugin);
  }
  for (const plugin of extras) byId.set(plugin.id, plugin);

  cached = build(dir, [...byId.values()]);
  return cached;
}

/** The loaded plugin set, or built-ins only if the async load has not run
 *  yet. Uses the default dir, not the configured one: `pluginsDir()` reads
 *  the store, and the store queries `loadedPlugins()` for its kinds, so
 *  resolving the dir here would recurse. The configured dir only matters to
 *  `ensurePluginsLoaded`, which is what fills the cache in the first
 *  place. */
export function loadedPlugins(): LoadedPlugins {
  if (cached) return cached;
  return build(defaultPluginsDir(), [...BUILT_IN]);
}

/** Drop the memo so the next `ensureLoadedPlugins` reloads. */
export function rescanPlugins(): void {
  cached = null;
}