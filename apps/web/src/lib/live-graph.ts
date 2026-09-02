import type {
  Block,
  BlockData,
  BlockGraph,
  BlockId,
  HookContext,
  Position,
} from "@repo/core";
import {
  childIds,
  insertBlock,
  lastChildId,
  moveBlock,
  removeBlock,
} from "@repo/core";
// Type-only: `@repo/store` reaches for node:sqlite, so a value import here
// would drag the whole persistence layer into the browser bundle.
import type { BlockInput } from "@repo/store";
import { kinds } from "@/blocks/kinds";

export type LiveGraphSnapshot = {
  graph: BlockGraph;
  /** Changed locally since the last successful save. */
  dirty: boolean;
  /** Epoch ms of the last successful save, or null before the first one. */
  savedAt: number | null;
  /** Blocks with a hook currently in flight — a run's only visible state
   *  while it is still running, since a hook's own state update lands all
   *  at once when it resolves. */
  running: ReadonlySet<BlockId>;
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
  runHook: (id: BlockId, hook: string, arg?: unknown) => Promise<void>;
  /** Apply an already-persisted field edit locally, so the row reflects it
   *  without waiting on a round trip back down. */
  updateField: (id: BlockId, name: string, value: string | number) => void;
  /** Link an already-persisted new block into the tree at `at`. */
  addBlock: (block: Block, at: Position) => void;
  /** Relink a block, and everything nested under it, at `at` — the whole of
   *  "moving" a block, reorder and nesting alike. */
  moveBlock: (id: BlockId, at: Position) => void;
  /** Drop a block and everything nested under it, optimistically. */
  deleteBlock: (id: BlockId) => void;
  toBlockInputs: () => BlockInput[];
  markSaved: () => void;
  markSaveFailed: () => void;
};

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
export function createLiveGraph(initial: BlockGraph): LiveGraph {
  let snapshot: LiveGraphSnapshot = {
    graph: initial,
    dirty: false,
    savedAt: null,
    running: new Set(),
  };
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) listener();
  }

  function commit(graph: BlockGraph, dirty: boolean) {
    snapshot = { ...snapshot, graph, dirty };
    emit();
  }

  function setRunning(id: BlockId, active: boolean) {
    const next = new Set(snapshot.running);
    if (active) next.add(id);
    else next.delete(id);
    snapshot = { ...snapshot, running: next };
    emit();
  }

  async function runHook(
    id: BlockId,
    hook: string,
    arg?: unknown,
  ): Promise<void> {
    const block = snapshot.graph.blocks[id];
    if (!block) return; // Stale reference (deleted target).
    const kind = kinds[block.kind];
    if (!kind) return;
    // A hook already running on this block finishes on its own; a second
    // trigger — a stray key repeat, an overlapping timer tick — is a no-op
    // rather than a second run racing the first over the same children.
    if (snapshot.running.has(id)) return;

    const ctx: HookContext = {
      id,
      graph: snapshot.graph,
      registry: kinds,
      call: async (targetId, name, callArg) => {
        try {
          await runHook(targetId, name, callArg);
        } catch (error) {
          console.error(
            `hook "${hook}" on ${block.kind} ${id} called ${name} on ${targetId}, which failed:`,
            error,
          );
        }
      },
      addBlock: (childKind, data, label, parentId = id) => {
        // Reads the live snapshot, not `ctx.graph`: a hook that cleared its
        // children first must append to what that left behind.
        const graph = snapshot.graph;
        const newId = crypto.randomUUID();
        const now = Date.now();
        const child: Block = {
          id: newId,
          kind: childKind,
          label,
          createdAt: now,
          modifiedAt: now,
          next: null,
          children: null,
          data,
        };
        commit(
          insertBlock(graph, child, {
            parentId,
            afterId: lastChildId(graph, parentId),
          }),
          true,
        );
        return newId;
      },
      clearChildren: (parentId = id) => {
        let graph = snapshot.graph;
        const children = childIds(graph, parentId);
        if (children.length === 0) return;
        for (const childId of children) graph = removeBlock(graph, childId);
        commit(graph, true);
      },
    };

    setRunning(id, true);
    let data: BlockData;
    try {
      data = await kind.call(block.data, hook, ctx, arg);
    } finally {
      setRunning(id, false);
    }
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
        ...snapshot.graph,
        blocks: {
          ...snapshot.graph.blocks,
          [id]: { ...current, data, modifiedAt: Date.now() },
        },
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
          ...snapshot.graph,
          blocks: {
            ...snapshot.graph.blocks,
            [id]: {
              ...current,
              data: { ...current.data, [name]: value },
              modifiedAt: Date.now(),
            },
          },
        },
        snapshot.dirty,
      );
    },
    addBlock(block, at) {
      commit(insertBlock(snapshot.graph, block, at), true);
    },
    moveBlock(id, at) {
      if (!snapshot.graph.blocks[id]) return;
      commit(moveBlock(snapshot.graph, id, at), true);
    },
    deleteBlock(id) {
      commit(removeBlock(snapshot.graph, id), true);
    },
    // A `Block` is already a valid `BlockInput`; the store ignores the extra
    // `modifiedAt`, which it owns.
    toBlockInputs: () => Object.values(snapshot.graph.blocks),
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
