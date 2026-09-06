import type { BlockKind } from "@repo/core";

/**
 * One setting a plugin contributes to the app's Settings page, described
 * purely so the app can render and edit it. No `value` or `onChange` lives
 * here: the app binds those to the plugin-owned settings store, so a plugin
 * never needs to know how its settings are persisted or who edits them.
 */
export type PluginSettingField =
  | {
      kind: "string";
      key: string;
      label: string;
      description: string;
      /** Shown, in gray, in place of an empty value, an example rather
       *  than a default. */
      placeholder?: string;
      /** Masked when not focused for editing, an API key. */
      secret?: boolean;
      /** Rejects a typed value on commit, returning why. A rejected edit
       *  stays in place with the draft intact. */
      validate?: (value: string) => string | null;
    }
  | {
      kind: "number";
      key: string;
      label: string;
      description: string;
      step: number;
      min?: number;
      max?: number;
    }
  | {
      kind: "option";
      key: string;
      label: string;
      description: string;
      options: readonly { value: string; label: string }[];
      /** Also editable by typing, like a string setting. */
      editable?: boolean;
    };

/**
 * Handed to a plugin tool's `execute` so the tool can read the plugin's own
 * settings without depending on the app's store or run wiring.
 */
export type ToolRunContext = {
  /** The value of `key` under plugin `pluginId`'s settings, or undefined if
   *  it was never set. */
  getSetting: (pluginId: string, key: string) => string | undefined;
};

/**
 * An agent tool a plugin contributes, as a structure the app mounts onto the
 * agent session runner. Kept tool-shaped rather than tied to a particular
 * agent SDK, so a plugin need not import one. `parameters` is a TypeBox
 * object schema; `execute` turns resolved arguments into text the model saw.
 */
export type PluginTool = {
  name: string;
  label: string;
  description: string | string[];
  /** TypeBox object schema the agent validates arguments against. */
  parameters: Record<string, unknown>;
  /** Resolve a call. Throw to report a failure. */
  execute: (
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ) => Promise<{ content: string; details: Record<string, unknown> }>;
};

/**
 * A plugin: a named bundle of block kinds, agent tools, and settings, built
 * from the standard `blocks/**` and `tools/**` shapes and shipped in a
 * directory of its own. The harness registers what the plugin declares.
 */
export type Plugin = {
  /** Stable id, e.g. "rich-media". Sets the settings storage key. */
  id: string;
  /** Display name for the Settings section and lists, e.g. "Rich media". */
  name: string;
  description: string;
  /** Settings the plugin contributes, one section per plugin. */
  settings?: PluginSettingField[];
  /** Block kinds the plugin registers into the graph's kind registry. */
  kinds?: BlockKind[];
  /** Agent tools the plugin contributes to every inference run. */
  tools?: PluginTool[];
};

/** Type-check a plugin literal without widening, so a plain object literal
 *  satisfies `Plugin` at its point of definition. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/** Every block kind contributed by `plugins`, in order. */
export function pluginKinds(plugins: Plugin[]): BlockKind[] {
  return plugins.flatMap((plugin) => plugin.kinds ?? []);
}

/** Every agent tool contributed by `plugins`, in order. */
export function pluginTools(plugins: Plugin[]): PluginTool[] {
  return plugins.flatMap((plugin) => plugin.tools ?? []);
}