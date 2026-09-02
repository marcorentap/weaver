import type { ZodType } from "zod";
import type { Block, BlockData, BlockGraph, BlockId } from "./block";

export type SnapshotContext = {
  /** The block being snapshotted, for metadata such as its label. */
  block: Block;
  /** Snapshot a nested block by id. */
  nested: (id: BlockId) => string;
  /** This block's children, already in resolved order. */
  children: BlockId[];
};

/**
 * Handed to a hook when it runs, so a hook can reach beyond its own state —
 * to call another block's hook by id, to read the graph around it, or to
 * add/replace its own nested output. This is the whole of "blocks acting on
 * the graph" for now: no wiring UI, no edges beyond what a kind's own state
 * already carries (a timer's `targetId`, say).
 */
export type HookContext = {
  /**
   * Invoke another block's named hook and let it run to completion. Silently
   * does nothing if `id` no longer exists or `hook` isn't one of its kind's
   * hooks — a stale reference should not crash the caller. `arg` is passed
   * through to the target hook verbatim; a caller with nothing to say
   * omits it.
   */
  call: (id: BlockId, hook: string, arg?: unknown) => Promise<void>;
  /** The id of the block whose hook is currently running. */
  id: BlockId;
  /**
   * The graph as of this hook's invocation — lets a hook look beyond its own
   * state at everything else, e.g. an agent block gathering its inference
   * context from the rest of the graph. A snapshot, not a live view:
   * mutations elsewhere during this hook's run are not reflected here. Use
   * `addBlock`/`clearChildren` to write, never by hand.
   */
  graph: BlockGraph;
  /** Every kind's definition, keyed by `BlockKind.kind` — lets a hook
   *  snapshot arbitrary blocks (via `snapshotBlock`/`snapshotGraph`) without
   *  needing its own reference to the app's registry. */
  registry: KindRegistry;
  /**
   * Appends a new block as a child of `parentId` (default: the block running
   * this hook), returning its id — lets a hook add to the graph instead of
   * only rewriting its own state, e.g. an agent nesting the model's reply
   * beneath itself.
   */
  addBlock: (
    kind: string,
    data: BlockData,
    label: string,
    parentId?: BlockId,
  ) => BlockId;
  /**
   * Deletes every current child of `parentId` (default: the block running
   * this hook) — lets a hook clear stale output before writing fresh
   * results, e.g. an agent re-run replacing its previous reply instead of
   * accumulating forever.
   */
  clearChildren: (parentId?: BlockId) => void;
};

/** A request from a kind's own state to have one of its hooks invoked on a
 *  timer — the "timer" primitive, generalized so no runtime needs to know
 *  which kind, if any, is the one calling itself "a timer". */
export type Schedule = { intervalMs: number; hook: string };

/**
 * Declares that two of a kind's own state fields together name a "callback"
 * — a reference to another block's hook, the same shape as a timer's
 * `targetId`/`hook` pair. Purely descriptive: nothing here calls anything,
 * it just lets a generic UI find and edit the reference without the kind
 * writing its own wiring screen.
 */
export type CallbackSpec = {
  /** Shown in the configure UI, e.g. "on tick". */
  label: string;
  /** State field holding the id of the block whose hook this calls. */
  targetField: string;
  /** State field holding the name of the hook on that block. */
  hookField: string;
  /** State field holding the JSON-encoded argument passed to the target
   *  hook, if any. Omit for a callback with no argument. */
  argField?: string;
};

/**
 * A block kind, erased of its state type so kinds can share one registry.
 * Build these with `defineKind`, never by hand.
 */
export type BlockKind = {
  kind: string;
  /**
   * The schema of this kind's state, kept alongside the erased `parse` so a
   * caller can *describe* a kind, not just validate against it — deriving a
   * JSON Schema to hand a model that creates blocks, say. Reading it is
   * fine; every write still goes through `parse`.
   */
  schema: ZodType<unknown>;
  /** Validate raw data into complete state. Throws when the schema fails. */
  parse: (data: BlockData) => unknown;
  /** Flatten validated state into the string handed to the LLM. */
  snapshot: (data: BlockData, ctx: SnapshotContext) => string;
  /** Names of hooks this kind exposes — callable by id from other blocks
   *  (a timer's target) or by the harness itself (a scheduler's tick). */
  hooks: readonly string[];
  /** State field pairs that reference another block's hook, for a generic
   *  configure UI to surface — see `CallbackSpec`. */
  callbacks: readonly CallbackSpec[];
  /**
   * Run one named hook against this block's current state and return its
   * next state. Throws if `data` fails the schema, if `hook` isn't one of
   * `hooks`, or if the hook's return value fails the schema — a hook that
   * drifts from its own kind's shape is a bug worth catching immediately,
   * not persisting.
   */
  call: (
    data: BlockData,
    hook: string,
    ctx: HookContext,
    arg?: unknown,
  ) => Promise<BlockData>;
  /**
   * Whether this block currently wants one of its own hooks invoked on a
   * timer, and how often — a timer block reads `intervalMs` off its own
   * state, say. A runtime scheduling this needs to know nothing about which
   * kind (if any) is "the" timer kind: every kind gets asked the same way,
   * and most simply never answer.
   */
  schedule: (data: BlockData) => Schedule | null;
  /** A fresh, schema-valid state for a brand-new block of this kind, or
   *  `null` if this kind cannot be created blank (nothing currently opts
   *  out, but the door stays open). Backs the "new block" picker: only
   *  kinds with a default show up there. */
  defaults: BlockData | null;
};

export type KindRegistry = Record<string, BlockKind>;

/**
 * Define a kind by the schema of its state.
 *
 * The schema is the whole definition of what a block of this kind is: the
 * unique set of data needed to reconstruct it. Everything downstream —
 * snapshotting, rendering, write validation — parses through it, so no
 * consumer ever handles partially-specified state.
 */
export function defineKind<S>(def: {
  kind: string;
  schema: ZodType<S>;
  snapshot: (state: S, ctx: SnapshotContext) => string;
  /**
   * Named functions this kind exposes. Each receives the block's current
   * (already-parsed) state and returns its next state — sync for pure
   * transforms, async for anything that does IO first (an HTTP fetch, say).
   */
  hooks?: Record<
    string,
    (state: S, ctx: HookContext, arg?: unknown) => Promise<S> | S
  >;
  /** State field pairs that reference another block's hook — see
   *  `CallbackSpec`. Omit for a kind with no such reference. */
  callbacks?: readonly CallbackSpec[];
  /** Whether this kind wants one of its own hooks invoked on a timer, given
   *  its current state. Omit for a kind that is never self-driving. */
  schedule?: (state: S) => Schedule | null;
  /** A fresh state new blocks of this kind start from. Parsed through the
   *  same schema as everything else, so a bad default fails at kind
   *  definition time instead of at first use. */
  defaults?: S;
}): BlockKind {
  const hooks = def.hooks ?? {};
  return {
    kind: def.kind,
    schema: def.schema as ZodType<unknown>,
    parse: (data) => def.schema.parse(data),
    // Parsing here means `def.snapshot` only ever receives complete state,
    // and no cast is needed to recover the state type.
    snapshot: (data, ctx) => def.snapshot(def.schema.parse(data), ctx),
    hooks: Object.keys(hooks),
    callbacks: def.callbacks ?? [],
    defaults: def.defaults !== undefined
      ? (def.schema.parse(def.defaults) as BlockData)
      : null,
    call: async (data, hook, ctx, arg) => {
      const fn = hooks[hook];
      if (!fn) {
        throw new Error(`kind "${def.kind}" has no hook named "${hook}"`);
      }
      const next = await fn(def.schema.parse(data), ctx, arg);
      return def.schema.parse(next) as BlockData;
    },
    schedule: (data) => def.schedule?.(def.schema.parse(data)) ?? null,
  };
}

export function kindRegistry(kinds: BlockKind[]): KindRegistry {
  const registry: KindRegistry = {};
  for (const kind of kinds) registry[kind.kind] = kind;
  return registry;
}
