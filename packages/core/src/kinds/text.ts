import { z } from "zod";
import { defineKind } from "../kind";

export const TEXT_KIND = "text";
export const COMPOSITE_KIND = "composite";

/** A literal string of context. */
export const textState = z.object({ text: z.string() });
export type TextState = z.infer<typeof textState>;

export const textKind = defineKind({
  kind: TEXT_KIND,
  schema: textState,
  snapshot: (state) => state.text,
});

/**
 * A block whose entire content is its children, so its own state is empty.
 * Nesting lives on `Block.children`, not in state, because every kind may
 * nest — not just this one.
 */
export const compositeState = z.object({});
export type CompositeState = z.infer<typeof compositeState>;

export const compositeKind = defineKind({
  kind: COMPOSITE_KIND,
  schema: compositeState,
  snapshot: (_state, ctx) => ctx.children.map((id) => ctx.nested(id)).join("\n"),
});

/** Kinds that ship with the harness. */
export const coreKinds = [textKind, compositeKind];
