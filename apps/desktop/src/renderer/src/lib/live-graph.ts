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
  findParent,
  insertBlock,
  lastChildId,
  moveBlock,
  removeBlock,
  snapshotAbove,
  snapshotBlock,
  TEXT_KIND,
} from "@repo/core";
// Type-only: `@repo/store` reaches for node:sqlite, so a value import here
// would drag the whole persistence layer into the renderer bundle.
import type { BlockInput } from "@repo/store";
import { kinds } from "@shared/blocks/kinds.js";
import { TOOL_KIND } from "@shared/blocks/tool.js";
import { streamInference } from "@/lib/inference";

export type LiveGraphSnapshot = {
  graph: BlockGraph;
  /** Changed locally since the last successful save. */
  dirty: boolean;
  /** Epoch ms of the last successful save, or null before the first one. */
  savedAt: number | null;
  /** Blocks with a hook or an inference run currently in flight. That is a
   *  run's only visible state while it is still running, since both a
   *  hook's and an inference run's own state update land all at once when
   *  they resolve. */
  running: ReadonlySet<BlockId>;
};

export type LiveGraph = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LiveGraphSnapshot;
  /**
   * Run a block's named hook and commit whatever state comes back. Entirely
   * kind-agnostic. It looks up `block.kind` in the registry and calls
   * whatever hook was asked for. It has no idea what a "timer" or an
   * "ISS location" is, and never needs to.
   */
  runHook: (id: BlockId, hook: string, arg?: unknown) => Promise<void>;
  /**
   * The global "run inference" action. Any block, not just one of a
   * particular kind, can anchor a run. Context is everything above `id`
   * (`snapshotAbove`); the prompt is `id`'s own content (`snapshotBlock`).
   * A block someone just typed becomes the last user turn. Results land
   * as siblings appended right after `id`, chained one after the next in
   * the order they streamed in, never nested under it. A re-run adds
   * another reply rather than replacing the last one.
   *
   * Lives on the engine, not a component, so the fetch stream survives the
   * view that started it unmounting (switching tabs and back). It keeps
   * appending into this graph regardless of who, if anyone, is watching.
   */
  runInference: (
    id: BlockId,
    options: { endpoint: string; apiKey: string; model: string; tools?: string[] },
  ) => Promise<void>;
  /** Apply an already-persisted field edit locally, so the row reflects it
   *  without waiting on a round trip back down. */
  updateField: (id: BlockId, name: string, value: string | number) => void;
  /** Abort the inference anchored at `id`, if one is in flight. */
  abortRun: (id: BlockId) => boolean;
  /** Link an already-persisted new block into the tree at `at`. */
  addBlock: (block: Block, at: Position) => void;
  /** Relink a block, and everything nested under it, at `at`. That is the
   *  whole of "moving" a block, reorder and nesting alike. */
  moveBlock: (id: BlockId, at: Position) => void;
  /** Drop a block and everything nested under it, optimistically. */
  deleteBlock: (id: BlockId) => void;
  toBlockInputs: () => BlockInput[];
  markSaved: () => void;
  markSaveFailed: () => void;
};

/**
 * A block graph that lives entirely in the browser once created. A hook (a
 * timer's tick, an ISS fetch, the engine doesn't know or care which) mutates
 * it directly and notifies subscribers immediately, so an update lands on
 * screen the instant it resolves rather than at the next poll or
 * revalidation.
 *
 * Deliberately plain, non-React state, built with `useSyncExternalStore` in
 * mind (same shape as `lib/settings`'s module-level store). Mutation and
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
  /** Cancel handle per in-flight inference, so an abort can be aimed at a
   *  specific block rather than being a global stop. */
  const runningAborts = new Map<BlockId, () => void>();

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
    // trigger, a stray key repeat or an overlapping timer tick, is a no-op
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
        // Reads the live snapshot, not `ctx.graph`. A hook that cleared its
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
    // No liveness check here on purpose. React StrictMode's dev-only
    // mount→cleanup→mount replays a component's effects once without ever
    // recreating this engine (it is cached in the live-graph registry, not
    // component state), so a "destroyed on cleanup" flag would go
    // permanently true on that first fake unmount and silently swallow
    // every real update for the rest of the session. A result landing
    // after the view holding this engine is gone just updates an object
    // nothing reads anymore. Harmless.
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

  async function runInference(
    id: BlockId,
    { endpoint, apiKey, model, tools = [] }: {
      endpoint: string;
      apiKey: string;
      model: string;
      tools?: string[];
    },
  ): Promise<void> {
    const block = snapshot.graph.blocks[id];
    if (!block) return; // Stale reference (deleted target).
    if (snapshot.running.has(id)) return; // Already running for this block.

    const parentId = findParent(snapshot.graph, id);
    let afterId: BlockId | null = id;
    const append = (kind: string, data: BlockData, label: string) => {
      const newId = crypto.randomUUID();
      const now = Date.now();
      const child: Block = {
        id: newId,
        kind,
        label,
        createdAt: now,
        modifiedAt: now,
        next: null,
        children: null,
        data,
      };
      commit(insertBlock(snapshot.graph, child, { parentId, afterId }), true);
      afterId = newId;
      return newId;
    };
    // The block a run's `text_delta` chunks are currently landing in. Null
    // between messages, so the first delta of a new one starts a fresh
    // block instead of gluing onto whatever came before it, such as a tool
    // result, a displayed block, or an earlier reply in the same run.
    let streamingId: BlockId | null = null;
    let streamingText = "";
    const appendDelta = (delta: string) => {
      streamingText += delta;
      if (streamingId === null) {
        streamingId = append(TEXT_KIND, { text: streamingText }, "assistant");
        return;
      }
      const current = snapshot.graph.blocks[streamingId];
      if (!current) return; // Deleted mid-stream.
      commit(
        {
          ...snapshot.graph,
          blocks: {
            ...snapshot.graph.blocks,
            [streamingId]: {
              ...current,
              data: { text: streamingText },
              modifiedAt: Date.now(),
            },
          },
        },
        true,
      );
    };
    // Pre-flight failures land as an appended error block too, and never
    // set `running`, because there is nothing in flight to show a spinner for.
    if (!endpoint || !apiKey || !model) {
      append(
        TEXT_KIND,
        { text: "missing endpoint, API key, or model. Check settings" },
        "error",
      );
      return;
    }
    const prompt = snapshotBlock(snapshot.graph, id, kinds);
    if (!prompt.trim()) {
      append(TEXT_KIND, { text: "block is empty. Nothing to send" }, "error");
      return;
    }
    const context = snapshotAbove(snapshot.graph, id, kinds);

    setRunning(id, true);
    try {
      let failure: string | null = null;
      const { done, cancel } = streamInference(
        { endpoint, apiKey, model, context, prompt, tools },
        (event) => {
          if (event.type === "text_delta") {
            appendDelta(event.text);
          } else if (event.type === "text") {
            // Deltas already streamed this message in, so the block already holds
            // it; this only ends the stream rather than appending a duplicate.
            // If no deltas arrived (a non-streaming provider, or text that
            // came with no preceding delta at all), append the message whole,
            // exactly as before deltas existed.
            if (streamingId !== null) {
              streamingId = null;
              streamingText = "";
            } else {
              append(TEXT_KIND, { text: event.text }, "assistant");
            }
          } else if (event.type === "tool") {
            streamingId = null;
            streamingText = "";
            append(
              TOOL_KIND,
              {
                name: event.name,
                args: event.args,
                output: event.output,
                ok: event.ok,
              },
              event.name,
            );
          } else if (event.type === "block") {
            streamingId = null;
            streamingText = "";
            const target = kinds[event.kind];
            if (!target) return;
            try {
              target.parse(event.data);
            } catch {
              return;
            }
            append(event.kind, event.data, event.label);
          } else if (event.type === "error") {
            failure = event.message;
          }
        },
      );
      runningAborts.set(id, cancel);
      await done;
      if (failure !== null) append(TEXT_KIND, { text: failure }, "error");
    } catch (error) {
      append(
        TEXT_KIND,
        { text: error instanceof Error ? error.message : String(error) },
        "error",
      );
    } finally {
      runningAborts.delete(id);
      setRunning(id, false);
    }
  }

  function abortRun(id: BlockId): boolean {
    const abort = runningAborts.get(id);
    if (!abort) return false;
    abort();
    return true;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    runHook,
    abortRun,
    runInference,
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
 * timer, per its kind's `schedule`. Kind-agnostic on purpose. A caller
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
