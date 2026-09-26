import { z } from "zod";
import { defineKind } from "@repo/core";

/**
 * A reply an inference run produced inside the graph. Its state is plain
 * text, the same as a `text` block's, and the two render alike. What makes
 * it its own kind is the role it takes in a serialized context: a run reads
 * the graph above it turn by turn, and this is how the model's own earlier
 * messages stay recognizable as its own, instead of arriving as one more
 * piece of the document.
 *
 * The counterpart of `USER_KIND`, on the other side of the conversation.
 */
export const ASSISTANT_KIND = "assistant";

export const assistantState = z.object({ text: z.string() });
export type AssistantState = z.infer<typeof assistantState>;

export const assistantKind = defineKind({
  kind: ASSISTANT_KIND,
  role: "assistant",
  schema: assistantState,
  snapshot: (state) => state.text,
  defaults: { text: "" },
});
