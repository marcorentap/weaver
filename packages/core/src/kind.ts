import type { ZodType } from "zod";
import type { Block, BlockData, BlockId } from "./block";

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
 * today, only to call another block's hook by id. This is the whole of
 * "blocks calling blocks" for now: no wiring UI, no edges, just a direct
 * reference a kind's own state carries (a timer's `targetId`, say).
 */
export type HookContext = {
  /**
   * Invoke another block's named hook and let it run to completion. Silently
   * does nothing if `id` no longer exists or `hook` isn't one of its kind's
   * hooks — a stale reference should not crash the caller.
   */
  call: (id: BlockId, hook: string) => Promise<void>;
};

/** A request from a kind's own state to have one of its hooks invoked on a
 *  timer — the "timer" primitive, generalized so no runtime needs to know
 *  which kind, if any, is the one calling itself "a timer". */
export type Schedule = { intervalMs: number; hook: string };

/**
 * A block kind, erased of its state type so kinds can share one registry.
 * Build these with `defineKind`, never by hand.
 */
export type BlockKind = {
  kind: string;
  /** Validate raw data into complete state. Throws when the schema fails. */
  parse: (data: BlockData) => unknown;
  /** Flatten validated state into the string handed to the LLM. */
  snapshot: (data: BlockData, ctx: SnapshotContext) => string;
  /** Names of hooks this kind exposes — callable by id from other blocks
   *  (a timer's target) or by the harness itself (a scheduler's tick). */
  hooks: readonly string[];
  /**
   * Run one named hook against this block's current state and return its
   * next state. Throws if `data` fails the schema, if `hook` isn't one of
   * `hooks`, or if the hook's return value fails the schema — a hook that
   * drifts from its own kind's shape is a bug worth catching immediately,
   * not persisting.
   */
  call: (data: BlockData, hook: string, ctx: HookContext) => Promise<BlockData>;
  /**
   * Whether this block currently wants one of its own hooks invoked on a
   * timer, and how often — a timer block reads `intervalMs` off its own
   * state, say. A runtime scheduling this needs to know nothing about which
   * kind (if any) is "the" timer kind: every kind gets asked the same way,
   * and most simply never answer.
   */
  schedule: (data: BlockData) => Schedule | null;
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
  hooks?: Record<string, (state: S, ctx: HookContext) => Promise<S> | S>;
  /** Whether this kind wants one of its own hooks invoked on a timer, given
   *  its current state. Omit for a kind that is never self-driving. */
  schedule?: (state: S) => Schedule | null;
}): BlockKind {
  const hooks = def.hooks ?? {};
  return {
    kind: def.kind,
    parse: (data) => def.schema.parse(data),
    // Parsing here means `def.snapshot` only ever receives complete state,
    // and no cast is needed to recover the state type.
    snapshot: (data, ctx) => def.snapshot(def.schema.parse(data), ctx),
    hooks: Object.keys(hooks),
    call: async (data, hook, ctx) => {
      const fn = hooks[hook];
      if (!fn) {
        throw new Error(`kind "${def.kind}" has no hook named "${hook}"`);
      }
      const next = await fn(def.schema.parse(data), ctx);
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
