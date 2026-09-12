import { z } from "zod";
import type { BlockGraph, BlockId } from "../block";
import { childIds, findParent, topLevelBlockIds } from "../block";
import { defineKind } from "../kind";

export const ENV_KIND = "environment";

/**
 * The one environment variable weaver itself reads. When the merged
 * environment that applies to a block defines it, a scheme-less media path
 * resolves relative to the directory it names, and an inference run
 * anchored there starts with that as its working directory.
 */
export const WEAVER_PWD = "WEAVER_PWD";

/** A block of `.env` text: `KEY=value` lines, `#` comments, blanks
 *  skipped. The values are read by whatever consumes the merged
 *  environment, not by the harness itself (except `WEAVER_PWD`). */
export const envState = z.object({ text: z.string() });
export type EnvState = z.infer<typeof envState>;

/**
 * An `.env` file, parsed into a variable map. A `#` comment or a blank line
 * is skipped; the first `=` on the line splits key from value; a leading
 * `export ` is dropped; matching quotes around the value are stripped. A
 * line with no `=` is not a variable assignment and is ignored.
 */
export function parseEnv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const rawKey = line.slice(0, eq).trim();
    const key = rawKey.startsWith("export ")
      ? rawKey.slice("export ".length).trim()
      : rawKey;
    if (key.length === 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      value.startsWith('"') &&
      value.endsWith('"')
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

export const environmentKind = defineKind({
  kind: ENV_KIND,
  schema: envState,
  // Names only, not values. An environment block configures processes, and
  // its values (API keys, paths) have no business flowing into the model's
  // context; the agent reads them from its own environment instead.
  snapshot: (state) => {
    const keys = Object.keys(parseEnv(state.text));
    return keys.length === 0 ? "" : keys.join(", ");
  },
  defaults: { text: "" },
});

/**
 * The merged environment that applies to `id`: every `environment` block
 * it can see, walked exactly the way `snapshotAbove` walks the graph (the
 * ancestor chain from the root down to `id`'s own level, taking all
 * preceding siblings at each stop), merged top-down so a closer block
 * overwrites a farther one. This is a block's view of "the environment so
 * far", not the whole graph. Blocks after `id` and anything after its
 * ancestors never contribute.
 */
export function mergedEnvironment(
  graph: BlockGraph,
  id: BlockId,
): Record<string, string> {
  const chain: BlockId[] = [];
  for (
    let parent = findParent(graph, id);
    parent !== null;
    parent = findParent(graph, parent)
  ) {
    chain.unshift(parent);
  }

  const merged: Record<string, string> = {};
  // Merge `blockId`'s environment in. `Object.entries` order on a plain
  // object is insertion order, so a closer block's own lines overwrite its
  // farther duplicate keys exactly as written. A hidden block is muted
  // here too: it is not serialized to the agent in any form, environment
  // included, until it is shown again.
  const apply = (blockId: BlockId): void => {
    const block = graph.blocks[blockId];
    if (!block || block.hidden || block.kind !== ENV_KIND) return;
    const state = envState.safeParse(block.data);
    if (!state.success) return;
    Object.assign(merged, parseEnv(state.data.text));
  };

  let siblings = topLevelBlockIds(graph);
  for (let level = 0; level <= chain.length; level++) {
    const target = level < chain.length ? (chain[level] as BlockId) : id;
    const index = siblings.indexOf(target);
    const preceding = index === -1 ? siblings : siblings.slice(0, index);
    for (const sibling of preceding) apply(sibling);
    if (level < chain.length) {
      siblings = childIds(graph, chain[level] as BlockId);
    }
  }
  return merged;
}