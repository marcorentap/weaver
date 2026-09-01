import type { Block, BlockGraph, BlockId } from "@repo/core";
import { getBlock, topLevelBlockIds, topoSort } from "@repo/core";

/** A block plus its nested contexts, already in render order. */
export type ChatNode = { block: Block; children: ChatNode[] };

/**
 * Containment tree in render order: every block in `ids` (top-level blocks,
 * by default), each carrying its own children the same way, recursively.
 * Framework-agnostic, so both the server's first render and the client's own
 * live re-derivation build the same shape from a `BlockGraph` the same way.
 */
export function chatNodes(
  graph: BlockGraph,
  ids: BlockId[] = topLevelBlockIds(graph),
): ChatNode[] {
  return topoSort(graph, ids).map((id) => {
    const block = getBlock(graph, id);
    return { block, children: chatNodes(graph, block.children) };
  });
}

/** Flatten a node tree back into the flat `{ id: Block }` map a `BlockGraph`
 *  wants — the inverse of `chatNodes`, used to seed client-side state from
 *  the server's initial tree. */
export function collectBlocks(
  nodes: ChatNode[],
  into: Record<BlockId, Block> = {},
): Record<BlockId, Block> {
  for (const node of nodes) {
    into[node.block.id] = node.block;
    collectBlocks(node.children, into);
  }
  return into;
}
