import type { KindRegistry } from "./kind";

export type BlockId = string;

/** Kind-specific payload. Persisted as JSON, so it must be JSON-serializable. */
export type BlockData = Record<string, unknown>;

/**
 * A context block.
 *
 * `kind` is an open discriminator naming a `BlockKind`, whose schema defines
 * the entire state this block needs. `children` is deliberately independent
 * of `kind`, so every kind may nest.
 */
export type Block<D extends BlockData = BlockData> = {
  id: BlockId;
  kind: string;
  label: string;
  /** Epoch ms of creation. Tiebreaker when topological order is ambiguous. */
  createdAt: number;
  /** Epoch ms of the last write. Blocks may update while the graph is live. */
  modifiedAt: number;
  /** DAG edges: this block is ordered after every parent. */
  parents: BlockId[];
  /** Containment. Renders as a branch; order is derived, never stored. */
  children: BlockId[];
  data: D;
};

/** Flat registry of every block. Edges live on the blocks themselves. */
export type BlockGraph = {
  blocks: Record<BlockId, Block>;
};

export function getBlock(graph: BlockGraph, id: BlockId): Block {
  const block = graph.blocks[id];
  if (!block) throw new Error(`unknown block: ${id}`);
  return block;
}

/** Ids of blocks that are not nested inside another block. */
export function topLevelBlockIds(graph: BlockGraph): BlockId[] {
  const nested = new Set<BlockId>();
  for (const block of Object.values(graph.blocks)) {
    for (const child of block.children) nested.add(child);
  }
  return Object.keys(graph.blocks).filter((id) => !nested.has(id));
}

/**
 * Topological order over `ids`, restricted to edges between those ids.
 * Ties are broken by timestamp, then id, so the order is deterministic.
 */
export function topoSort(graph: BlockGraph, ids: BlockId[]): BlockId[] {
  const within = new Set(ids);
  const indegree = new Map<BlockId, number>();
  const dependents = new Map<BlockId, BlockId[]>();

  for (const id of ids) {
    const parents = getBlock(graph, id).parents.filter((p) => within.has(p));
    indegree.set(id, parents.length);
    for (const parent of parents) {
      const list = dependents.get(parent);
      if (list) list.push(id);
      else dependents.set(parent, [id]);
    }
  }

  const byPriority = (a: BlockId, b: BlockId) => {
    const ta = getBlock(graph, a).createdAt;
    const tb = getBlock(graph, b).createdAt;
    return ta === tb ? a.localeCompare(b) : ta - tb;
  };

  const ready = ids.filter((id) => indegree.get(id) === 0).sort(byPriority);
  const order: BlockId[] = [];

  while (ready.length > 0) {
    const id = ready.shift() as BlockId;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        // Keep `ready` sorted so timestamp order decides among available blocks.
        const at = ready.findIndex((other) => byPriority(dependent, other) < 0);
        if (at === -1) ready.push(dependent);
        else ready.splice(at, 0, dependent);
      }
    }
  }

  if (order.length !== ids.length) {
    throw new Error("block graph contains a cycle");
  }
  return order;
}

/**
 * Throws unless both relations are acyclic. `depends` is checked by the
 * topological sort itself; `contains` needs its own walk, since a block
 * nested inside its own descendant would recurse forever when snapshotting.
 */
export function assertAcyclic(graph: BlockGraph): void {
  topoSort(graph, Object.keys(graph.blocks));

  const done = new Set<BlockId>();
  const onPath = new Set<BlockId>();

  const walk = (id: BlockId) => {
    if (done.has(id)) return;
    if (onPath.has(id)) {
      throw new Error(`block containment forms a cycle at: ${id}`);
    }
    onPath.add(id);
    for (const child of graph.blocks[id]?.children ?? []) walk(child);
    onPath.delete(id);
    done.add(id);
  };

  for (const id of Object.keys(graph.blocks)) walk(id);
}

/**
 * Flatten a block into its LLM string. Unknown kinds throw rather than guess:
 * silently wrong context is worse than a loud failure, and a purely visual
 * block can register a snapshot that returns "".
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
  return kind.snapshot(block.data, {
    block,
    nested: (childId) => snapshotBlock(graph, childId, registry),
    children: topoSort(graph, block.children),
  });
}

/** Snapshot the whole graph: every top-level block, in topological order. */
export function snapshotGraph(
  graph: BlockGraph,
  registry: KindRegistry,
): string {
  return topoSort(graph, topLevelBlockIds(graph))
    .map((id) => snapshotBlock(graph, id, registry))
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
