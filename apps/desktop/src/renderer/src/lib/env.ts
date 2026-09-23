import {
  ENV_KIND,
  envState,
  mergedEnvironment,
  parseEnv,
  WEAVER_PWD,
  type BlockGraph,
  type BlockId,
  type Position,
} from "@repo/core";

/**
 * The `WEAVER_PWD` an inference run anchored at `id` would start in: the
 * value of every `environment` block the block can see, closest overriding
 * farthest. This is the same `mergedEnvironment` a run sends as `env`, so
 * "where am I" is one answer, not a lookup the UI and the agent disagree
 * about. Undefined when no environment block above sets the variable.
 */
export function pwdForBlock(
  graph: BlockGraph,
  id: BlockId,
): string | undefined {
  return mergedEnvironment(graph, id)[WEAVER_PWD];
}

/**
 * The same value for a block that does not exist yet, about to be inserted
 * at `at`. `mergedEnvironment` is defined on a block, so it is evaluated on
 * the nearest anchor: the sibling the new block follows (whose own
 * `environment` body applies to it, since a block sees everything before
 * it) or, for a first child, the parent. Undefined when nothing above sets
 * it, or when the position is the very top of the graph.
 */
export function pwdForPosition(
  graph: BlockGraph,
  at: Position,
): string | undefined {
  const anchor = at.afterId ?? at.parentId;
  if (anchor === null) return undefined;
  const env = mergedEnvironment(graph, anchor);
  if (at.afterId !== null) {
    // `mergedEnvironment` excludes its own block, but the new block follows
    // `afterId`, so an environment block there does apply to it.
    const block = graph.blocks[at.afterId];
    if (block && !block.hidden && block.kind === ENV_KIND) {
      const state = envState.safeParse(block.data);
      if (state.success) Object.assign(env, parseEnv(state.data.text));
    }
  }
  return env[WEAVER_PWD];
}