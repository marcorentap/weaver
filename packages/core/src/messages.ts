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
 * One image a turn carries alongside its text, named by URI rather than by
 * bytes. A block holds the address of a picture, not the picture; reading it
 * is a filesystem (or network) act, which belongs to whoever sends the
 * request, not to the graph model. The mime type travels with it because the
 * kind that recognized the file already knows it (`mediaInfo`), and a
 * consumer building a data URL has no business guessing from the extension
 * twice.
 */
export type ContextImage = { uri: string; mimeType: string };

/**
 * One piece of context as a turn: the role its content takes in a
 * conversation, and the content itself. This is the unit a run sends a
 * model, in place of one flattened string — the shape a provider expects,
 * and the shape that keeps what a person wrote, what a run answered, and the
 * material around them distinct.
 *
 * A turn may also carry `images` — pictures the block showed rather than
 * described. They are kept apart from `content` because they cannot be
 * flattened into it: a vision model takes them as content parts of their
 * own, and a model that takes text only must be handed the description the
 * snapshot already provides rather than a URI it cannot open.
 */
export type ContextMessage = {
  role: MessageRole;
  content: string;
  images?: ContextImage[];
};

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
  const ctx = snapshotContext(graph, id, registry, { context: true });
  if (kind.turns) {
    return kind.turns(block.data, ctx);
  }
  const role = roleOf(block, registry);
  const images = kind.images?.(block.data, ctx) ?? [];
  return [
    {
      role,
      content: snapshotBlock(graph, id, registry, {
        label: role === "developer",
        context: true,
      }),
      // The snapshot is what the block says; the images are what the block
      // shows. Both go: a text-only model still reads the description, and a
      // vision model gets the picture beside it.
      ...(images.length > 0 ? { images: [...images] } : {}),
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
 *   told nothing in the loudest possible way. A turn that is empty but
 *   carries images is not empty: a picture to look at is a contribution of
 *   its own, even with nothing written about it.
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
      if (!message.content.trim() && !message.images?.length) continue;
      const open = messages[messages.length - 1];
      if (open && open.role === message.role) {
        // Images ride along with the text they were merged into: a run of
        // material blocks becomes one message, and the pictures among them
        // stay in the order their blocks had.
        open.content = open.content
          ? `${open.content}\n\n${message.content}`
          : message.content;
        if (message.images?.length) {
          open.images = [...(open.images ?? []), ...message.images];
        }
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
