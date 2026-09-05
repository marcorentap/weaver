import { z } from "zod";
import { defineKind } from "../kind";

export const TEXT_KIND = "text";
export const GROUP_KIND = "group";

/** A literal string of context. */
export const textState = z.object({ text: z.string() });
export type TextState = z.infer<typeof textState>;

export const textKind = defineKind({
  kind: TEXT_KIND,
  schema: textState,
  snapshot: (state) => state.text,
  defaults: { text: "" },
});

/**
 * A block whose entire content is its children, so its own state is empty.
 * Nesting lives on `Block.children`, not in state, because every kind may
 * nest, not just this one.
 */
export const groupState = z.object({});
export type GroupState = z.infer<typeof groupState>;

export const groupKind = defineKind({
  kind: GROUP_KIND,
  schema: groupState,
  snapshot: (_state, ctx) => ctx.children.map((id) => ctx.nested(id)).join("\n"),
  defaults: {},
});

/** Kinds that ship with the harness. */
export const coreKinds = [textKind, groupKind];
