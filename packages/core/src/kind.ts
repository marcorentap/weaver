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
 * A block kind, erased of its state type so kinds can share one registry.
 * Build these with `defineKind`, never by hand.
 */
export type BlockKind = {
  kind: string;
  /** Validate raw data into complete state. Throws when the schema fails. */
  parse: (data: BlockData) => unknown;
  /** Flatten validated state into the string handed to the LLM. */
  snapshot: (data: BlockData, ctx: SnapshotContext) => string;
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
}): BlockKind {
  return {
    kind: def.kind,
    parse: (data) => def.schema.parse(data),
    // Parsing here means `def.snapshot` only ever receives complete state,
    // and no cast is needed to recover the state type.
    snapshot: (data, ctx) => def.snapshot(def.schema.parse(data), ctx),
  };
}

export function kindRegistry(kinds: BlockKind[]): KindRegistry {
  const registry: KindRegistry = {};
  for (const kind of kinds) registry[kind.kind] = kind;
  return registry;
}
