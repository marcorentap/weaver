import type { Block, BlockGraph, BlockId } from "./block";
import {
  getBlock,
  precedingBlockIds,
  snapshotBlock,
  snapshotContext,
  topLevelBlockIds,
} from "./block";
import type { KindRegistry, MessageRole } from "./kind";
import { TEXT_KIND } from "./kinds/text";

/**
 * One piece of context as a turn: the role its content takes in a
 * conversation, and the content itself. This is the unit a run sends a
 * model, in place of one flattened string — the shape a provider expects,
 * and the shape that keeps what a person wrote, what a run answered, and the
 * material around them distinct.
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
 * The turns one block contributes, in order.
 *
 * Most blocks are one turn: their snapshot, under the role their kind plays,
 * keeping the label when that role is `developer` — `tool: read …` says which
 * call the material came from, where `user: …` would only repeat the role. A
 * kind may instead answer for itself, because one block can hold both sides
 * of an exchange: a question a run raised and the person's answer to it are
 * one `multichoice` block and two turns. Nothing here needs to know which
 * kind does that; it asks the kind and takes what it is given.
 *
 * This is the whole of how a block becomes turns, for the graph above a run
 * (`messagesAbove`) and for the block a run is anchored on alike, so a block
 * cannot read one way in context and another when it is the one being run.
 * The exclusions are here rather than at the callers for the same reason:
 * hidden, opted out, and (for a kind whose turns are built from state)
 * nothing to say are all answers of "this block contributes no turns".
 */
export function messagesOfBlock(
  graph: BlockGraph,
  id: BlockId,
  registry: KindRegistry,
): ContextMessage[] {
  const block = getBlock(graph, id);
  // A hidden block contributes nothing, here or as the subject of a run: its
  // subtree is hidden with it, and hiding is how a person takes material out
  // of what the model reads without deleting it.
  if (block.hidden) return [];
  const kind = registry[block.kind];
  if (!kind) {
    throw new Error(`no kind registered for block kind: ${block.kind}`);
  }
  // A kind that opted out of a run's context contributes nothing, wherever
  // its block sits — here and, through the option carry-down, nested inside
  // any block that does contribute.
  if (!kind.context) return [];
  if (kind.turns) {
    return kind.turns(
      block.data,
      snapshotContext(graph, id, registry, { context: true }),
    );
  }
  const role = roleOf(block, registry);
  return [
    {
      role,
      content: snapshotBlock(graph, id, registry, {
        label: role === "developer",
        context: true,
      }),
    },
  ];
}

/**
 * A list of blocks, in the order given, as turn-by-turn messages rather than
 * one flattened blob — a run's material with the roles the blocks already
 * hold, whatever the caller's scope. Each block arrives with the role its
 * kind plays instead of as another line of text, which lets a model read the
 * document the way it reads a conversation: a `user` message is something the
 * person said, an `assistant` message is something a run answered, and a
 * `developer` message is material to work from, not a turn to continue. A
 * block that holds both sides of an exchange contributes both turns, in
 * order (see `messagesOfBlock`).
 *
 * Two adjustments make that a request a provider will accept:
 *
 * - Blocks are grouped by role. Adjacent messages of the same role become
 *   one, joined by a blank line, so a run of `developer` material is one
 *   instruction block rather than ten consecutive ones — the same reason a
 *   paragraph is not ten paragraphs. A `user` or `assistant` message that is
 *   not a turn whose role already says who wrote it drops its label, which
 *   would only repeat the role ("assistant: …").
 * - Empty turns are dropped instead of becoming empty messages. A hidden
 *   block, a group with nothing under it, a kind that opted out of context
 *   (`BlockKind.context`), and a question nobody has answered yet all
 *   contribute nothing, and a provider reading an empty message has been
 *   told nothing in the loudest possible way.
 *
 * This is the one place blocks become a request's messages, so a run over
 * the graph above a block and a run over an explicit list of blocks (a
 * summarization's targets, say) cannot read their material differently.
 */
export function messagesOfBlocks(
  graph: BlockGraph,
  ids: BlockId[],
  registry: KindRegistry,
): ContextMessage[] {
  const messages: ContextMessage[] = [];
  for (const id of ids) {
    for (const message of messagesOfBlock(graph, id, registry)) {
      if (!message.content.trim()) continue;
      const open = messages[messages.length - 1];
      if (open && open.role === message.role) {
        open.content = `${open.content}\n\n${message.content}`;
      } else {
        messages.push({ ...message });
      }
    }
  }
  return messages;
}

/**
 * Everything that appears before `id`, as turn-by-turn messages rather than
 * one flattened blob. The walk is `precedingBlockIds`' — the same one
 * `mergedEnvironment` makes, so what a block sees as context cannot disagree
 * with what it sees as environment — and the turns
 * are the same `messagesOfBlocks` builds for any list of blocks.
 */
export function messagesAbove(
  graph: BlockGraph,
  id: BlockId,
  registry: KindRegistry,
): ContextMessage[] {
  return messagesOfBlocks(graph, precedingBlockIds(graph, id), registry);
}

/**
 * The whole visible graph, in order, as turn-by-turn messages: every
 * top-level block, hidden ones contributing nothing (with `messagesOfBlock`'s
 * own exclusions applying below them). This is the session as a document,
 * read as a conversation rather than as one flattened string, for a caller
 * whose material is the session itself: a run that names the session, say,
 * which should read what a run over any block reads, not a lossier
 * re-rendering of it.
 */
export function messagesOfGraph(
  graph: BlockGraph,
  registry: KindRegistry,
): ContextMessage[] {
  return messagesOfBlocks(graph, topLevelBlockIds(graph), registry);
}
