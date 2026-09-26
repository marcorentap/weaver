import type { Block, BlockGraph, BlockId } from "./block";
import { getBlock, precedingBlockIds, snapshotBlock } from "./block";
import type { KindRegistry, MessageRole } from "./kind";
import { TEXT_KIND } from "./kinds/text";

/**
 * One block of context as a turn: the role the block's kind plays in a
 * conversation, and its snapshot as that turn's content. This is the unit a
 * run sends a model, in place of one flattened string — the shape a provider
 * expects, and the shape that keeps what a person wrote, what a run answered,
 * and the material around them distinct.
 */
export type ContextMessage = { role: MessageRole; content: string };

/**
 * The role a block takes in a serialized context, from its kind. Kinds that
 * are not a turn of their own are `developer` (see `MessageRole`).
 *
 * One exception, for reading old sessions: before the `assistant` kind
 * existed, an inference run's reply was a `text` block labeled "assistant".
 * Those blocks cannot be migrated without rewriting every saved graph, so
 * they are recognized here and keep reading as the assistant turn they were.
 */
function roleOf(block: Block, registry: KindRegistry): MessageRole {
  if (block.kind === TEXT_KIND && block.label === "assistant") {
    return "assistant";
  }
  return registry[block.kind]?.role ?? "developer";
}

/**
 * Everything that appears before `id`, as turn-by-turn messages rather than
 * one flattened blob. The walk is `precedingBlockIds`' — the same one
 * `snapshotAbove` and `mergedEnvironment` make, so what a block sees as
 * context cannot disagree with what it sees as environment — but each block
 * arrives with the role its kind plays instead of as another line of text,
 * which lets a model read the document the way it reads a conversation: a
 * `user` message is something the person said, an `assistant` message is
 * something a run answered, and a `developer` message is material to work
 * from, not a turn to continue.
 *
 * Two adjustments make that a request a provider will accept:
 *
 * - Blocks are grouped by role. Adjacent blocks of the same role become one
 *   message, joined by a blank line, so a run of `developer` material is one
 *   instruction block rather than ten consecutive ones — the same reason a
 *   paragraph is not ten paragraphs. A `user` or `assistant` message that is
 *   not a turn whose role already says who wrote it drops its label, which
 *   would only repeat the role ("assistant: …").
 * - Empty snapshots are dropped instead of becoming empty messages. A hidden
 *   block and a group with nothing under it both snapshot to "", and a
 *   provider reading an empty message has been told nothing in the loudest
 *   possible way.
 */
export function messagesAbove(
  graph: BlockGraph,
  id: BlockId,
  registry: KindRegistry,
): ContextMessage[] {
  const messages: ContextMessage[] = [];
  for (const sibling of precedingBlockIds(graph, id)) {
    if (getBlock(graph, sibling).hidden) continue;
    const role = roleOf(getBlock(graph, sibling), registry);
    const content = snapshotBlock(graph, sibling, registry, {
      label: role === "developer",
    });
    if (!content.trim()) continue;
    const open = messages[messages.length - 1];
    if (open && open.role === role) {
      open.content = `${open.content}\n\n${content}`;
    } else {
      messages.push({ role, content });
    }
  }
  return messages;
}
