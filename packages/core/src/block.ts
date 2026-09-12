import type { KindRegistry } from "./kind";

export type BlockId = string;

/** Kind-specific payload. Persisted as JSON, so it must be JSON-serializable. */
export type BlockData = Record<string, unknown>;

/**
 * A context block, and the two links that place it in the graph.
 *
 * The graph is a binary tree used as a linked list of linked lists: `next`
 * is the following block at this level, `children` is the first block nested
* inside this one. Both orderings are explicit, not derived from timestamps,
 * so nothing can disagree about what comes after what. Nesting is
 * independent of `kind`, so every kind may nest.
 */
export type Block<D extends BlockData = BlockData> = {
  id: BlockId;
  kind: string;
  label: string;
  /** Epoch ms of creation. Metadata only; order lives in the links. */
  createdAt: number;
  /** Epoch ms of the last write. Blocks may update while the graph is live. */
  modifiedAt: number;
  /** The next block at this level, or null at the end of the chain. */
  next: BlockId | null;
  /** First nested block, or null when nothing is nested here. */
  children: BlockId | null;
  data: D;
};

/** Every block, plus the head of the top-level chain. */
export type BlockGraph = {
  blocks: Record<BlockId, Block>;
  /** First top-level block; null only when the graph holds nothing. */
  root: BlockId | null;
};

/**
 * Where a block sits: right after `afterId`, in the chain nested under
 * `parentId`. `afterId` null means "first in that chain"; `parentId` null
 * means the top-level chain. When both are given `afterId` decides, since it
 * already names the chain.
 */
export type Position = { parentId: BlockId | null; afterId: BlockId | null };

export function getBlock(graph: BlockGraph, id: BlockId): Block {
  const block = graph.blocks[id];
  if (!block) throw new Error(`unknown block: ${id}`);
  return block;
}

/**
 * Every id along one `next` chain, starting at `first`. Loops throw rather
 * than hang. A chain that eats itself is corruption, and a renderer walking
 * it would otherwise never return.
 */
export function chainIds(graph: BlockGraph, first: BlockId | null): BlockId[] {
  const ids: BlockId[] = [];
  const seen = new Set<BlockId>();
  for (let at = first; at !== null; at = getBlock(graph, at).next) {
    if (seen.has(at)) throw new Error(`block chain loops at: ${at}`);
    seen.add(at);
    ids.push(at);
  }
  return ids;
}

/** Ids of the top-level chain, in order. */
export function topLevelBlockIds(graph: BlockGraph): BlockId[] {
  return chainIds(graph, graph.root);
}

/** Ids nested directly inside `id`, in order. */
export function childIds(graph: BlockGraph, id: BlockId): BlockId[] {
  return chainIds(graph, getBlock(graph, id).children);
}

/** Last block nested inside `id`, or null when nothing is. */
export function lastChildId(graph: BlockGraph, id: BlockId): BlockId | null {
  const children = childIds(graph, id);
  return children.length > 0 ? (children[children.length - 1] as BlockId) : null;
}

/**
 * The block `id` is nested in, or null when `id` is top-level. Every chain
 * is walked at most once across the whole scan, so this costs one pass over
 * the graph rather than one per level.
 */
export function findParent(graph: BlockGraph, id: BlockId): BlockId | null {
  for (const block of Object.values(graph.blocks)) {
    if (block.children === null) continue;
    for (const child of chainIds(graph, block.children)) {
      if (child === id) return block.id;
    }
  }
  return null;
}

/** The block whose `next` is `id`, or null when `id` starts its chain. */
export function findPrevSibling(
  graph: BlockGraph,
  id: BlockId,
): BlockId | null {
  for (const block of Object.values(graph.blocks)) {
    if (block.next === id) return block.id;
  }
  return null;
}

/** Where `id` currently sits, in the shape `moveBlock` takes. */
export function positionOf(graph: BlockGraph, id: BlockId): Position {
  return {
    parentId: findParent(graph, id),
    afterId: findPrevSibling(graph, id),
  };
}

/** `id` and everything nested beneath it, containers before their contents. */
export function subtreeIds(graph: BlockGraph, id: BlockId): BlockId[] {
  const ids: BlockId[] = [id];
  for (const child of childIds(graph, id)) {
    ids.push(...subtreeIds(graph, child));
  }
  return ids;
}

/**
 * The head of the top-level chain implied by a set of blocks: the one block
 * nothing links to. Lets storage keep the links on the blocks themselves and
 * still hand back a `BlockGraph`, instead of tracking a root pointer
 * separately and letting the two drift.
 */
export function rootOf(blocks: Record<BlockId, Block>): BlockId | null {
  const linked = new Set<BlockId>();
  for (const block of Object.values(blocks)) {
    if (block.next !== null) linked.add(block.next);
    if (block.children !== null) linked.add(block.children);
  }
  const heads = Object.values(blocks).filter((block) => !linked.has(block.id));
  if (heads.length > 1) {
    throw new Error(
      `graph has ${heads.length} unlinked blocks, expected one root`,
    );
  }
  if (heads.length === 0 && Object.keys(blocks).length > 0) {
    throw new Error("graph has no root; its links form a cycle");
  }
  return heads[0]?.id ?? null;
}

/** Pointer surgery for a block already in `graph` but linked from nowhere. */
function link(graph: BlockGraph, id: BlockId, at: Position): BlockGraph {
  const block = getBlock(graph, id);
  const blocks = { ...graph.blocks };

  if (at.afterId !== null) {
    const after = getBlock(graph, at.afterId);
    blocks[id] = { ...block, next: after.next };
    blocks[at.afterId] = { ...after, next: id };
    return { blocks, root: graph.root };
  }
  if (at.parentId !== null) {
    const parent = getBlock(graph, at.parentId);
    blocks[id] = { ...block, next: parent.children };
    blocks[at.parentId] = { ...parent, children: id };
    return { blocks, root: graph.root };
  }
  blocks[id] = { ...block, next: graph.root };
  return { blocks, root: id };
}

/** Detach `id` from its chain, keeping whatever is nested under it. */
function unlink(graph: BlockGraph, id: BlockId): BlockGraph {
  const block = getBlock(graph, id);
  const blocks = { ...graph.blocks, [id]: { ...block, next: null } };
  let root = graph.root;

  const prev = findPrevSibling(graph, id);
  if (prev !== null) {
    blocks[prev] = { ...getBlock(graph, prev), next: block.next };
  } else {
    const parent = findParent(graph, id);
    if (parent !== null) {
      blocks[parent] = { ...getBlock(graph, parent), children: block.next };
    } else if (root === id) {
      root = block.next;
    }
  }
  return { blocks, root };
}

/**
 * Add a block the graph does not have yet at `at`. Whatever the block already
 * names as `children` comes with it; its `next` is rewritten by the insert.
 */
export function insertBlock(
  graph: BlockGraph,
  block: Block,
  at: Position,
): BlockGraph {
  if (graph.blocks[block.id]) {
    throw new Error(`block already in graph: ${block.id}`);
  }
  const seeded: BlockGraph = {
    blocks: { ...graph.blocks, [block.id]: { ...block, next: null } },
    root: graph.root,
  };
  return link(seeded, block.id, at);
}

/**
 * Move `id`, and everything nested under it, to `at`. Moving a block into
 * its own subtree throws. That would cut the moved branch out of the tree
 * entirely, leaving a ring nothing can reach.
 */
export function moveBlock(
  graph: BlockGraph,
  id: BlockId,
  at: Position,
): BlockGraph {
  getBlock(graph, id);
  if (at.afterId === id) return graph;

  const subtree = new Set(subtreeIds(graph, id));
  if (
    (at.parentId !== null && subtree.has(at.parentId)) ||
    (at.afterId !== null && subtree.has(at.afterId))
  ) {
    throw new Error(`cannot move block ${id} inside itself`);
  }
  return link(unlink(graph, id), id, at);
}

/** Drop `id` and everything nested under it, closing the chain behind it. */
export function removeBlock(graph: BlockGraph, id: BlockId): BlockGraph {
  if (!graph.blocks[id]) return graph;

  const detached = unlink(graph, id);
  const doomed = new Set(subtreeIds(detached, id));
  const blocks: Record<BlockId, Block> = {};
  for (const [key, block] of Object.entries(detached.blocks)) {
    if (!doomed.has(key)) blocks[key] = block;
  }
  return { blocks, root: detached.root };
}

/**
 * Throws unless the links really form a tree: every reachable link resolves,
 * no block is reached twice, which is also how a loop shows up, and no
 * stored block is unreachable. An unreachable block is as bad as a dangling
 * link. It renders nowhere, yet the store keeps saving it forever.
 */
export function assertTree(graph: BlockGraph): void {
  const seen = new Set<BlockId>();

  const walk = (first: BlockId | null, parent: BlockId | null) => {
    for (let at = first; at !== null; ) {
      const block = graph.blocks[at];
      if (!block) {
        const from = parent === null ? "the top-level chain" : `block ${parent}`;
        throw new Error(`${from} links to unknown block: ${at}`);
      }
      if (seen.has(at)) {
        throw new Error(`block is reachable twice: ${at}`);
      }
      seen.add(at);
      walk(block.children, at);
      at = block.next;
    }
  };
  walk(graph.root, null);

  for (const id of Object.keys(graph.blocks)) {
    if (!seen.has(id)) {
      throw new Error(`block is unreachable from the root: ${id}`);
    }
  }
}

/**
 * Flatten a block into its LLM string, prefixed with the block's own label
 * (`label: body`) so an agent reading the flattened graph can tell blocks
 * apart by who or what produced them, not just by juxtaposition. A block
 * with no label, or whose kind snapshots to "", is returned unprefixed: an
 * empty snapshot means "nothing to show", not "a label with nothing after
 * it", and a checked-empty prompt (e.g. an empty trigger block) must stay
 * checkably empty. Unknown kinds throw rather than guess: silently wrong
 * context is worse than a loud failure, and a purely visual block can
 * register a snapshot that returns "".
 */
export function snapshotBlock(
  graph: BlockGraph,
  id: BlockId,
  registry: KindRegistry,
): string {
  const block = getBlock(graph, id);
  const kind = registry[block.kind];
  if (!kind) {
    throw new Error(`no kind registered for block kind: ${block.kind}`);
  }
  const body = kind.snapshot(block.data, {
    block,
    nested: (childId) => snapshotBlock(graph, childId, registry),
    children: childIds(graph, id),
  });
  if (!body || !block.label) return body;
  return `${block.label}: ${body}`;
}

/** Snapshot the whole graph: every top-level block, in order. */
export function snapshotGraph(
  graph: BlockGraph,
  registry: KindRegistry,
): string {
  return topLevelBlockIds(graph)
    .map((id) => snapshotBlock(graph, id, registry))
    .join("\n");
}

/**
 * Everything that appears before `id`, in order: the ancestor chain from
 * the root down to `id`'s direct parent, and at every level, starting at
 * the top and ending at `id`'s own siblings, every block that comes before
 * the next step on the way down to `id`. `id`'s own subtree, the blocks
 * after it, and anything after its ancestors are never included. This is a
 * block's view of "the graph so far", not the whole graph — and the same
 * ordering `mergedEnvironment` folds environment blocks in, so context and
 * environment can never disagree about what comes before a block.
 */
export function precedingBlockIds(
  graph: BlockGraph,
  id: BlockId,
): BlockId[] {
  const chain: BlockId[] = [];
  for (
    let parent = findParent(graph, id);
    parent !== null;
    parent = findParent(graph, parent)
  ) {
    chain.unshift(parent);
  }

  const ids: BlockId[] = [];
  let siblings = topLevelBlockIds(graph);
  for (let level = 0; level <= chain.length; level++) {
    const target = level < chain.length ? (chain[level] as BlockId) : id;
    const index = siblings.indexOf(target);
    const preceding = index === -1 ? siblings : siblings.slice(0, index);
    ids.push(...preceding);
    if (level < chain.length) {
      siblings = childIds(graph, chain[level] as BlockId);
    }
  }
  return ids;
}

/**
 * Everything that appears before `id`, walking up from it: the ids of
 * `precedingBlockIds`, each snapshotted in full and joined top-down (farthest
 * first). This is a block's view of "the graph so far", not the whole graph.
 */
export function snapshotAbove(
  graph: BlockGraph,
  id: BlockId,
  registry: KindRegistry,
): string {
  return precedingBlockIds(graph, id)
    .map((sibling) => snapshotBlock(graph, sibling, registry))
    .join("\n");
}

/** Validate every block's data against its kind schema. */
export function assertValidData(
  graph: BlockGraph,
  registry: KindRegistry,
): void {
  for (const block of Object.values(graph.blocks)) {
    const kind = registry[block.kind];
    if (!kind) continue;
    kind.parse(block.data);
  }
}
