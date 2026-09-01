import type { Block, BlockGraph, BlockId, HookContext } from "@repo/core";
import type { BlockInput } from "@repo/store";
import { kinds } from "@/blocks/kinds";

export type LiveGraphSnapshot = {
  graph: BlockGraph;
  /** Changed locally since the last successful save. */
  dirty: boolean;
  /** Epoch ms of the last successful save, or null before the first one. */
  savedAt: number | null;
};

export type LiveGraph = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LiveGraphSnapshot;
  /**
   * Run a block's named hook and commit whatever state comes back. Entirely
   * kind-agnostic: it looks up `block.kind` in the registry and calls
   * whatever hook was asked for — it has no idea what a "timer" or an
   * "ISS location" is, and never needs to.
   */
  runHook: (id: BlockId, hook: string) => Promise<void>;
  /** Apply an already-persisted field edit locally, so the row reflects it
   *  without waiting on a round trip back down. */
  updateField: (id: BlockId, name: string, value: string | number) => void;
  /** Insert an already-persisted new block locally. `parentId` null means
   *  top-level; otherwise the block is appended to that block's children. */
  addBlock: (block: Block, parentId: BlockId | null) => void;
  /** Reorder one block among its siblings by giving it a new `createdAt` —
   *  siblings are ordered by topological tiebreak on `createdAt`, so this is
   *  the whole of "moving" a block without touching containment. */
  setCreatedAt: (id: BlockId, createdAt: number) => void;
  /** Move a block from one container to another (either may be null for
   *  top-level) and give it a new `createdAt` in its new position, in one
   *  commit — used by nest/unnest. */
  moveBlock: (
    id: BlockId,
    fromParentId: BlockId | null,
    toParentId: BlockId | null,
    createdAt: number,
  ) => void;
  /** Drop a block and every reference to it, optimistically. */
  deleteBlock: (id: BlockId) => void;
  toBlockInputs: () => BlockInput[];
  markSaved: () => void;
  markSaveFailed: () => void;
};

function withoutBlock(
  blocks: Record<BlockId, Block>,
  id: BlockId,
): Record<BlockId, Block> {
  const next: Record<BlockId, Block> = {};
  for (const [key, block] of Object.entries(blocks)) {
    if (key === id) continue;
    next[key] = {
      ...block,
      parents: block.parents.filter((p) => p !== id),
      children: block.children.filter((c) => c !== id),
    };
  }
  return next;
}

function toBlockInputs(blocks: Record<BlockId, Block>): BlockInput[] {
  return Object.values(blocks).map((block) => ({
    id: block.id,
    kind: block.kind,
    label: block.label,
    createdAt: block.createdAt,
    parents: block.parents,
    children: block.children,
    data: block.data,
  }));
}

/**
 * A block graph that lives entirely in the browser once created: a hook (a
 * timer's tick, an ISS fetch — the engine doesn't know or care which) mutates
 * it directly and notifies subscribers immediately, so an update lands on
 * screen the instant it resolves rather than at the next poll or
 * revalidation.
 *
 * Deliberately plain, non-React state, built with `useSyncExternalStore` in
 * mind (same shape as `lib/settings`'s module-level store) — mutation and
 * `Date.now()` are exactly what a live graph needs, and keeping both out of
 * any component's own render path is what keeps a page using this
 * compatible with the React Compiler, which assumes render is pure.
 */
export function createLiveGraph(blocks: Record<BlockId, Block>): LiveGraph {
  let snapshot: LiveGraphSnapshot = {
    graph: { blocks },
    dirty: false,
    savedAt: null,
  };
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) listener();
  }

  function commit(nextBlocks: Record<BlockId, Block>, dirty: boolean) {
    snapshot = { ...snapshot, graph: { blocks: nextBlocks }, dirty };
    emit();
  }

  async function runHook(id: BlockId, hook: string): Promise<void> {
    const block = snapshot.graph.blocks[id];
    if (!block) return; // Stale reference (deleted target).
    const kind = kinds[block.kind];
    if (!kind) return;

    const ctx: HookContext = {
      call: async (targetId, name) => {
        try {
          await runHook(targetId, name);
        } catch (error) {
          console.error(
            `hook "${hook}" on ${block.kind} ${id} called ${name} on ${targetId}, which failed:`,
            error,
          );
        }
      },
    };

    const data = await kind.call(block.data, hook, ctx);
    // No liveness check here on purpose: React StrictMode's dev-only
    // mount→cleanup→mount replays a component's effects once without ever
    // recreating this engine (it lives in `useState`), so a "destroyed on
    // cleanup" flag would go permanently true on that first fake unmount
    // and silently swallow every real update for the rest of the session. A
    // result landing after the view holding this engine is truly gone just
    // updates an object nothing reads anymore — harmless.
    const current = snapshot.graph.blocks[id];
    if (!current) return; // Deleted while the hook was in flight.
    commit(
      {
        ...snapshot.graph.blocks,
        [id]: { ...current, data, modifiedAt: Date.now() },
      },
      true,
    );
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    runHook,
    updateField(id, name, value) {
      const current = snapshot.graph.blocks[id];
      if (!current) return;
      commit(
        {
          ...snapshot.graph.blocks,
          [id]: {
            ...current,
            data: { ...current.data, [name]: value },
            modifiedAt: Date.now(),
          },
        },
        snapshot.dirty,
      );
    },
    addBlock(block, parentId) {
      const blocks: Record<BlockId, Block> = {
        ...snapshot.graph.blocks,
        [block.id]: block,
      };
      const parent = parentId ? blocks[parentId] : undefined;
      if (parent) {
        blocks[parentId as BlockId] = {
          ...parent,
          children: [...parent.children, block.id],
        };
      }
      commit(blocks, true);
    },
    setCreatedAt(id, createdAt) {
      const current = snapshot.graph.blocks[id];
      if (!current) return;
      commit(
        { ...snapshot.graph.blocks, [id]: { ...current, createdAt, modifiedAt: Date.now() } },
        true,
      );
    },
    moveBlock(id, fromParentId, toParentId, createdAt) {
      const current = snapshot.graph.blocks[id];
      if (!current) return;
      const blocks: Record<BlockId, Block> = { ...snapshot.graph.blocks };
      if (fromParentId) {
        const from = blocks[fromParentId];
        if (from) {
          blocks[fromParentId] = {
            ...from,
            children: from.children.filter((childId) => childId !== id),
          };
        }
      }
      if (toParentId) {
        const to = blocks[toParentId];
        if (to && !to.children.includes(id)) {
          blocks[toParentId] = { ...to, children: [...to.children, id] };
        }
      }
      blocks[id] = { ...current, createdAt, modifiedAt: Date.now() };
      commit(blocks, true);
    },
    deleteBlock(id) {
      commit(withoutBlock(snapshot.graph.blocks, id), true);
    },
    toBlockInputs: () => toBlockInputs(snapshot.graph.blocks),
    markSaved() {
      snapshot = { ...snapshot, dirty: false, savedAt: Date.now() };
      emit();
    },
    markSaveFailed() {
      snapshot = { ...snapshot, dirty: true };
      emit();
    },
  };
}

/**
 * Every block currently asking for a hook of its own to be invoked on a
 * timer, per its kind's `schedule`. Kind-agnostic on purpose: a caller
 * reconciling this against real `setInterval`s never needs to know "timer"
 * exists as a concept, let alone which kind implements it.
 */
export function scheduledHooks(
  graph: BlockGraph,
): { id: BlockId; intervalMs: number; hook: string }[] {
  return Object.values(graph.blocks).flatMap((block) => {
    const schedule = kinds[block.kind]?.schedule(block.data) ?? null;
    return schedule ? [{ id: block.id, ...schedule }] : [];
  });
}
