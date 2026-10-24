import type { BlockData, BlockKind, ContextMessage } from "@repo/core";

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
  /**
   * Append a new block of `kind` into the graph, as a sibling right after
   * the block the current run is anchored on. Only present when the harness
   * can materialize blocks (an agent run inside the app does; a bare tool
   * caller may not), so a tool that wants one must treat it as optional: if
   * it is missing, fall back to plain text instead of assuming the block
   * was added. The data is validated against the kind before it lands, so
   * a tool can pass its own state and let the harness reject a bad shape.
   */
  addBlock?: (kind: string, data: BlockData, label: string) => void;
  /**
   * Append a new block of `kind` and hold the run until that block resumes
   * it: until the person answers it, its kind's `resume` reads an answer out
   * of the updated state, and that text settles this promise. The one call a
   * tool makes when the answer to a question it must ask is not something it
   * can guess; a tool that just wants to show something uses `addBlock`, which
   * returns at once.
   *
   * Resolves with the answer, or null when nothing will answer it: a harness
   * that cannot materialize blocks, a run that was cancelled, or a block the
   * user discarded before answering. Null is not an empty answer — a kind
   * that resumes at all resumes with text — so a tool can tell "nobody
   * answered" from "answered with nothing" and say so to the model rather
   * than reporting an answer that never came. Like `addBlock`, optional: a
   * tool that needs an answer must only pause when it is there, and fall back
   * to plain text when it is not.
   */
  wait?: (
    kind: string,
    data: BlockData,
    label: string,
  ) => Promise<string | null>;
  /**
   * Run a subagent on `messages` and return what it finally answered, or
   * throw when its run failed. The messages are the subagent's whole
   * context, sent as the turns they already are: a `user` message is an
   * instruction to it, an `assistant` message is something it should treat as
   * its own earlier reply, and a `developer` message is material it reads but
   * is not continuing. The subagent inherits this run's inference
   * configuration and environment, and its own transcript lands nested under
   * the block of the tool call that spawned it, so an agent spawning another
   * is visible as that call's branch rather than as more of this run's
   * output.
   *
   * `agent` names the Weaver agent the subagent should be invoked as — the
   * same name a person attaches with `@agents:` and a run request carries as
   * its `agent`. Omitted, the subagent runs as the agent this run is
   * invoked as, so a spawning chain stays within one agent unless a tool
   * deliberately crosses to another. A name nothing holds fails that
   * subagent's run rather than quietly falling back, the way an unknown
   * agent fails a run of its own.
   *
   * Optional on the same terms as the other two: a harness that cannot run a
   * nested agent omits it, and a tool that needs one must say so in text
   * instead of assuming it exists. The subagent is itself an agent run, so a
   * tool mounted on this run is mounted on that one too — spawning may
   * recurse.
   */
  spawnAgent?: (messages: ContextMessage[], agent?: string) => Promise<string>;
  /**
   * The call this tool is executing, as it came off the wire: `args` is the
   * JSON string the model sent, exactly as the request carried it.
   *
   * A tool that materializes a block for its own call needs this, because
   * only the call itself knows what the arguments were. Rebuilding them from
   * the block is lossy in a way that costs a prompt cache: a tool that
   * trims, deduplicates, or defaults an optional parameter would replay a
   * call the model never made, and everything after it in the conversation
   * would stop matching the request that produced it. Optional on the same
   * terms as the rest — a bare tool host has no wire to quote.
   */
  call?: { args: string };
};

/**
 * What a tool can learn about the run it is being mounted on, for a
 * description that cannot be written until then. `agents` is the shelves as
 * this run sees them: a tool taking an agent name has to say which names it
 * could take, and that list is a fact about the run's working directory —
 * not about the tool — so it arrives here rather than being hard-coded and
 * going stale.
 */
export type ToolScope = {
  /** The Weaver agents this run could name, merged across the project's
   *  shelf and the user's, with each one's `DESCRIPTION.md`. Empty on a run
   *  whose working directory has none. */
  agents: { name: string; description: string }[];
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
  /**
   * What the tool is for, in the words the model reads. A function is
   * called at mount time with the run's `ToolScope`, for a tool whose
   * options are whatever the run can see: the agents a subagent tool could
   * be asked to name differ per project, and a static description would
   * either lie about them or leave them out.
   */
  description: string | string[] | ((scope: ToolScope) => string | string[]);
  /** TypeBox object schema the agent validates arguments against. */
  parameters: Record<string, unknown>;
  /**
   * Run this tool's batch one call at a time rather than letting its calls
   * overlap. The agent SDK runs a whole batch of tool calls concurrently by
   * default; setting this makes the batch containing this tool sequential, so
   * two of its calls cannot be in flight at once. For a tool whose calls
   * genuinely cannot share a moment — one that mutates a resource the whole
   * batch contends for — that is not a preference; a tool whose only reason
   * would be a nested run's transcript is not: `spawnAgent`'s transcript is
   * scoped to the call that spawned it, so concurrent subagents land in their
   * own branches rather than in one another's.
   */
  sequential?: boolean;
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
