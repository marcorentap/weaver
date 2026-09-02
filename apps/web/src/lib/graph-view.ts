import type { Block, BlockGraph, BlockId } from "@repo/core";
import { childIds, getBlock, topLevelBlockIds } from "@repo/core";

/** A block plus its nested contexts, already in render order. */
export type ChatNode = { block: Block; children: ChatNode[] };

/**
 * The tree behind a chain of `next` links, materialized for rendering: every
 * block in `ids` (the top-level chain, by default), each carrying its own
 * nested chain the same way, recursively. Framework-agnostic, so both the
 * server's first render and the client's own live re-derivation build the
 * same shape from a `BlockGraph` the same way.
 */
export function chatNodes(
  graph: BlockGraph,
  ids: BlockId[] = topLevelBlockIds(graph),
): ChatNode[] {
  return ids.map((id) => ({
    block: getBlock(graph, id),
    children: chatNodes(graph, childIds(graph, id)),
  }));
}
