import type { Block, BlockGraph, BlockId } from "./block";
import { getBlock, topLevelBlockIds, topoSort } from "./block";

/**
 * One rendered line of the graph: exactly one block, plus the rail geometry
 * needed to draw git-style lines to its left. All lane numbers are absolute
 * column indices, so a renderer can map them straight to x coordinates.
 */
export type GraphRow = {
  block: Block;
  /** Nesting level. 0 is top level; group children are deeper. */
  depth: number;
  /** Column this block's node sits in. */
  lane: number;
  /** Node connects straight up to the previous block in its own lane. */
  continuesUp: boolean;
  /** Node connects straight down to a later block in its own lane. */
  continuesDown: boolean;
  /** Lanes above that curve into this node (extra DAG parents). */
  merges: number[];
  /** Lanes below that curve out of this node (extra DAG children, nesting). */
  branches: number[];
  /** Unrelated lanes whose lines pass straight through this line. */
  verticals: number[];
  /** Spines of enclosing nesting groups that pass through this line. */
  spines: number[];
  /** Spines that terminate on this line (drawn only down to the node). */
  spineEnds: number[];
};

export type GraphLayout = {
  rows: GraphRow[];
  /** Total columns in use, for sizing the rail. */
  laneCount: number;
};

function allocLane(lanes: (BlockId | null)[]): number {
  const free = lanes.indexOf(null);
  if (free !== -1) return free;
  lanes.push(null);
  return lanes.length - 1;
}

type LevelContext = {
  graph: BlockGraph;
  rows: GraphRow[];
  /** Absolute lanes of ancestor DAG lines that must keep flowing downward. */
  outerVerticals: number[];
  /** Absolute lanes of enclosing nesting-group spines. */
  spines: number[];
};

function emitLevel(
  ctx: LevelContext,
  ids: BlockId[],
  baseLane: number,
  depth: number,
): void {
  if (ids.length === 0) return;

  const order = topoSort(ctx.graph, ids);
  const within = new Set(ids);

  // Children restricted to this nesting level; topo order keeps them below.
  const childrenOf = new Map<BlockId, BlockId[]>();
  for (const id of order) {
    for (const parent of getBlock(ctx.graph, id).parents) {
      if (!within.has(parent)) continue;
      const list = childrenOf.get(parent);
      if (list) list.push(id);
      else childrenOf.set(parent, [id]);
    }
  }

  // lanes[i] holds the block a pending edge in column i is waiting to reach.
  const lanes: (BlockId | null)[] = [];

  for (const id of order) {
    const block = getBlock(ctx.graph, id);

    const incoming: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === id) incoming.push(i);
    }

    let lane: number;
    let continuesUp = false;
    const merges: number[] = [];
    if (incoming.length > 0) {
      lane = incoming[0] as number;
      continuesUp = true;
      for (const i of incoming) lanes[i] = null;
      for (const i of incoming.slice(1)) merges.push(baseLane + i);
    } else {
      lane = allocLane(lanes);
    }
    // Reserve the lane so child allocation below cannot reuse it.
    lanes[lane] = id;

    const verticals = [...ctx.outerVerticals];
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] !== null) verticals.push(baseLane + i);
    }

    const children = childrenOf.get(id) ?? [];
    const branches: number[] = [];
    let continuesDown = false;
    children.forEach((child, index) => {
      if (index === 0) {
        lanes[lane] = child;
        continuesDown = true;
      } else {
        const extra = allocLane(lanes);
        lanes[extra] = child;
        branches.push(baseLane + extra);
      }
    });
    if (children.length === 0) lanes[lane] = null;

    // Layout is kind-agnostic: every block may nest, custom kinds included.
    const nested = block.children;

    // Lanes still carrying a line once this line is drawn. A nested group has
    // to start right of all of them, or its rail would sit on top of one.
    const stillOpen = [...ctx.outerVerticals, ...ctx.spines, baseLane + lane];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null) stillOpen.push(baseLane + i);
    }
    const nestedBase = Math.max(...stillOpen) + 1;
    if (nested.length > 0) branches.push(nestedBase);

    const row: GraphRow = {
      block,
      depth,
      lane: baseLane + lane,
      continuesUp,
      continuesDown,
      merges,
      branches,
      verticals,
      spines: [...ctx.spines],
      spineEnds: [],
    };
    ctx.rows.push(row);

    if (nested.length > 0) {
      // Nested rows must keep drawing this level's still-open lines.
      const nestedOuter = [...ctx.outerVerticals];
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i] !== null) nestedOuter.push(baseLane + i);
      }
      emitLevel(
        {
          graph: ctx.graph,
          rows: ctx.rows,
          outerVerticals: nestedOuter,
          spines: [...ctx.spines, nestedBase],
        },
        nested,
        nestedBase,
        depth + 1,
      );
      // Terminate this group's spine on the last line it produced.
      const last = ctx.rows[ctx.rows.length - 1];
      if (last) last.spineEnds.push(nestedBase);
    }
  }
}

export function layoutGraph(graph: BlockGraph): GraphLayout {
  const rows: GraphRow[] = [];
  emitLevel(
    { graph, rows, outerVerticals: [], spines: [] },
    topLevelBlockIds(graph),
    0,
    0,
  );

  let maxLane = 0;
  for (const row of rows) {
    for (const lane of [
      row.lane,
      ...row.merges,
      ...row.branches,
      ...row.verticals,
      ...row.spines,
    ]) {
      if (lane > maxLane) maxLane = lane;
    }
  }

  return { rows, laneCount: maxLane + 1 };
}
