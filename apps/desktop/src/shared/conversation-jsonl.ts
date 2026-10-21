import {
  messagesOfGraph,
  type BlockGraph,
  type KindRegistry,
} from "@repo/core";

/**
 * A conversation as JSONL: one JSON object per turn, in graph order, with
 * the role each block's kind already gives it.
 *
 * This is the same view a run over the session reads (`messagesOfGraph`), not
 * a re-rendering of it, so an exported conversation is what the model saw
 * rather than a second interpretation of the blocks that could disagree with
 * the first. Hidden blocks, kinds marked `context: false` (the environment
 * block) and blank turns contribute nothing, exactly as they contribute
 * nothing to a run.
 *
 * Pictures travel as the URIs they were stored as, beside the text
 * description the snapshot already wrote: an export cannot carry the bytes of
 * a local file, but it can name them.
 *
 * Both sides build their JSONL here: main for the all-conversations archive,
 * the renderer for the one session the chat page has open (whose live state
 * is fresher than the store, and may not have been written there at all).
 */
export function conversationJsonl(
  graph: BlockGraph,
  registry: KindRegistry,
): string {
  return (
    messagesOfGraph(graph, registry)
      .map((message) =>
        JSON.stringify({
          role: message.role,
          content: message.content,
          ...(message.images?.length ? { images: message.images } : {}),
        }),
      )
      .join("\n") + "\n"
  );
}
