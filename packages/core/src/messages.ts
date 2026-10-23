import type { Block, BlockGraph, BlockId } from "./block";
import {
  getBlock,
  precedingBlockIds,
  snapshotBlock,
  snapshotContext,
  topLevelBlockIds,
} from "./block";
import type {
  BlockKind,
  KindRegistry,
  MessageRole,
  SnapshotContext,
} from "./kind";
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
  role: ContextRole;
  content: string;
  images?: ContextImage[];
  /**
   * The calls an `assistant` turn made, for a turn that came off a wire.
   * A provider's transcript is not a sequence of prose: an assistant message
   * may answer with text and tool calls at once, and the calls are answered
   * by messages of their own. Reproducing that shape is what lets a
   * re-serialized graph line up, token for token, with the request the run
   * that wrote it actually sent.
   */
  toolCalls?: ContextToolCall[];
  /** Which call a `tool` turn answers, matching a `ContextToolCall.id` on the
   *  `assistant` turn before it. */
  toolCallId?: string;
  /** The reasoning a model produced before an `assistant` turn's text, where
   *  the provider had it on the wire and the block kept it. */
  reasoning?: string;
};

/**
 * The roles a replayed turn may take: the three a weaver block can be, plus
 * `tool`, which no block is — a tool result is not a document, it is the
 * answer to a call, and a provider only accepts it as `tool` role with the
 * id of the call it answers.
 */
export type ContextRole = MessageRole | "tool";

/** One call an assistant turn made, named as the wire names it: an id the
 *  following `tool` turn quotes back, the function's name, and its arguments
 *  as the JSON string the provider sent them in. Kept as a string rather
 *  than an object because re-encoding an object is not guaranteed to produce
 *  the same bytes, and the same bytes are the whole point. */
export type ContextToolCall = { id: string; name: string; args: string };

/**
 * The role a block takes in a serialized context, from its kind. Kinds that
 * are not a turn of their own are `developer` (see `MessageRole`).
 *
 * Two exceptions, and both are the graph remembering something the kind alone
 * cannot say. For reading old sessions: before the `assistant` kind existed,
 * an inference run's reply was a `text` block labeled "assistant". Those
 * blocks cannot be migrated without rewriting every saved graph, so they are
 * recognized here and keep reading as the assistant turn they were. And a
 * block a run was anchored on is a `user` turn wherever it is read afterward:
 * whatever kind it belongs to, the run sent its document as the ask, and the
 * transcript a later run replays has to hold that same user message in that
 * same place (see `Block.asked`).
 */
function roleOf(block: Block, registry: KindRegistry): MessageRole {
  if (block.kind === TEXT_KIND && block.label === "assistant") {
    return "assistant";
  }
  if (block.asked) return "user";
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
  // A kind that answers with its own turns does not where the block was a
  // run's ask: the run sent the block's document as one user turn, not the
  // exchange the kind holds, so the turns it would have given are not what
  // went out. An unanswered question run on is the case that needs this —
  // its own reading ends on the question as an assistant turn, which is the
  // opposite of what the run sent.
  if (kind.turns && !block.asked) {
    return kind.turns(block.data, ctx);
  }
  const role = roleOf(block, registry);
  const images = kind.images?.(block.data, ctx) ?? [];
  return [
    {
      role,
      content: snapshotBlock(graph, id, registry, {
        // The label is dropped where the role already says who is speaking —
        // except for a block a run asked with. There the label was part of
        // the text that run sent, since the ask is the block's document whole
        // (`snapshotBlock` with its prefix), so dropping it would replay a
        // message one word shorter than the one on the wire.
        label: role === "developer" || Boolean(block.asked),
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

/**
 * A block's form on the wire, where it differs from its form as a document.
 *
 * A snapshot answers "what does this block say", which is the right question
 * for a preview, a summary, or a piece of material a model reads once. It is
 * the wrong question for a turn that came *off* a wire: an agent's tool call
 * was an `assistant` message with `tool_calls` on it, answered by a `tool`
 * message quoting the call's id, and no amount of prose about the call
 * reproduces it. A provider caches a request by its prefix, so a transcript
 * that is re-rendered as prose is a transcript whose cache misses from the
 * first tool call onward, on every run.
 *
 * `wire` is therefore the block as it travelled, in the two shapes a weaver
 * graph cannot otherwise hold:
 *
 * - `reasoning` is what the model thought before it spoke. It belongs to the
 *   next assistant turn, which is why it is a part rather than a message.
 * - `toolCall` is one call an assistant turn made and the result it got: one
 *   half lands on the assistant turn before it, the other becomes the `tool`
 *   message after it. A block that has both is why one block cannot simply
 *   be one message.
 *
 * A kind with no `wire` has no past on a wire to reproduce, and reads as
 * `messagesOfBlock` says.
 */
export type WirePart =
  | { wire: "reasoning"; text: string }
  | {
      wire: "toolCall";
      name: string;
      args: string;
      result: string;
      /**
       * The pictures the call's result carried, by URI.
       *
       * A tool that reads a picture hands the model the file itself, and the
       * wire does not fold those bytes into the `tool` message: the message
       * is text, and the pictures follow it as a `user` turn of their own,
       * under a line saying what they are. A replay that keeps only `result`
       * therefore loses a message at that call — and every token after it,
       * since a provider caches by prefix. Omitted when the call showed
       * nothing, which is every call but a picture read on a model that
       * takes one.
       */
      images?: ContextImage[];
      /**
       * Which assistant message of the run made this call, as that run named
       * it, or undefined for a call whose record does not say.
       *
       * The graph's order alone cannot answer the one question the wire asks
       * about a call: whether two calls in a row were two entries of one
       * message's `tool_calls` or two messages that each called once. A model
       * that called three tools in one turn and a model that called one, read
       * the result, then called the next, produce the identical run of tool
       * blocks — no text and no reasoning between them either way — and the
       * two transcripts are not remotely the same request. Reading a sequence
       * as a batch moves every call and result ahead of the message that
       * produced it, which costs the whole prefix. The run that watched the
       * calls happen is the only thing that knows, so it names the message
       * here and `transcriptOfBlocks` groups by it.
       *
       * Optional because a block written before this was recorded still has
       * to parse, and because a plugin's own call carries no run to ask.
       */
      turn?: string;
    };

/**
 * Whether a block is the graph's record of a model's reasoning rather than
 * something a person put there. It is recognized by kind and label because
 * that is how it was written before a kind of its own existed, and every
 * graph saved since still holds those blocks; `wireOf` and
 * `transcriptOfBlocks` ask this one question so the two cannot drift apart
 * about which block an exception is being made for.
 */
function isReasoningBlock(block: Block): boolean {
  return block.kind === TEXT_KIND && block.label === "thinking";
}

/**
 * The wire form of one block, or null for a block that never had one. The
 * text block labeled `thinking` is the same kind of exception `roleOf` makes
 * for the one labeled `assistant`: before a kind existed for reasoning, the
 * harness wrote it as a text block with that label, and every graph saved
 * since still holds those blocks.
 */
function wireOf(
  block: Block,
  kind: BlockKind,
  ctx: SnapshotContext,
): WirePart | null {
  // A block someone ran on has a truer past than its call: the run sent the
  // block's document as a user turn, not a replayed tool call, so the ask
  // wins and the block reads through `messagesOfBlock` instead. Without this
  // a `display_media` block re-run as a question would report a call the
  // later request never made, and drop the question entirely.
  if (block.asked) return null;
  if (isReasoningBlock(block)) {
    return { wire: "reasoning", text: kind.snapshot(block.data, ctx) };
  }
  return kind.wire?.(block.data, ctx) ?? null;
}

/** Join two pieces of reasoning into one.
 *
 * The separator is `\n`, not a blank line, because that is how the request
 * builder on the other side of the wire joins the thinking blocks of one
 * assistant message (`convertMessages` in pi's openai-completions API:
 * `nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n")`). One
 * assistant message that carried two thinking blocks reached the graph as two
 * `thinking` blocks, and rejoining them with anything else would produce a
 * `reasoning_content` value the run that wrote them never sent — a prefix
 * mismatch at that message, and so a cache miss from there on. */
function joinReasoning(open: string | null, next: string): string {
  return open ? `${open}\n${next}` : next;
}

/**
 * A list of blocks as the provider transcript they came from, rather than as
 * the documents they read as.
 *
 * This is the same walk as `messagesOfBlocks` and the same blocks, with the
 * blocks that have a wire form put back in that form: an assistant turn keeps
 * the tool calls it made, each answered by a `tool` message quoting the call's
 * id, and the turn keeps the reasoning that preceded it. What has no wire form
 * — a file someone attached, a note above the conversation, an environment
 * block's absence — reads exactly as before. A run that sends this instead of
 * `messagesAbove` sends, for everything that already happened, the bytes the
 * run that wrote it sent, which is the only condition under which a provider's
 * prefix cache can hit across runs at all.
 *
 * Three differences from the document walk follow from that, and each exists
 * for the same reason: the wire is not a document.
 *
 * - Turns of the same role are not merged, except `developer` material. Two
 *   `user` blocks in a row were two messages on the wire, and gluing them
 *   into one changes the bytes. `developer` material is weaver's own — it
 *   never was on any wire — so grouping it costs nothing and says it better.
 * - A `tool` message is never dropped for being empty. A call that printed
 *   nothing was still a call, and a provider rejects a tool call left
 *   unanswered.
 * - Call ids are minted here, `call_1`, `call_2`, … in transcript order,
 *   because the graph never kept the provider's. They are not meant to match
 *   the ids of the run that wrote the blocks; they are meant to be identical
 *   in every later serialization of the same graph, and to agree with
 *   `canonicalToolCallIds` on the wire side, which renames pi's own ids to the
 *   same scheme so that a run's live transcript and its replay read alike.
 */
export function transcriptOfBlocks(
  graph: BlockGraph,
  ids: BlockId[],
  registry: KindRegistry,
): ContextMessage[] {
  const messages: ContextMessage[] = [];
  // The assistant turn tool calls may still attach to: the last one emitted,
  // and only while nothing has closed it. A tool block is answered by the
  // turn above it because that is the only turn a provider would accept it
  // after.
  let open: ContextMessage | null = null;
  // Which assistant message that open turn is, where the block that opened it
  // said. Null is not "no turn" but "not recorded": a turn opened by an
  // assistant block carries no turn of its own, and the first call that has
  // one binds it.
  let openTurn: string | null = null;
  // Reasoning that has arrived and whose assistant turn has not. It belongs
  // to the next assistant turn, which may be one this walk has to invent (a
  // turn that called tools without saying anything first).
  let reasoning: string | null = null;
  let calls = 0;
  const takeReasoning = (): string | undefined => {
    const text = reasoning;
    reasoning = null;
    return text ?? undefined;
  };

  for (const id of ids) {
    const block = getBlock(graph, id);
    // Hiding is how a person takes material out of what a run reads, so a
    // hidden block contributes nothing — with one exception, and it is not
    // a loophole in hiding but a case hiding was never about. Reasoning is
    // the model's own prior turn, and the renderer keeps it in the graph
    // hidden because a session is read as answers, not as deliberation. A
    // provider, though, was shown an assistant message with that reasoning
    // before it; a request that drops it is a request whose prefix ends
    // where the reasoning began, which is a cache miss on every turn after
    // it for every reasoning model. So a hidden reasoning block still
    // contributes its reasoning, and nothing else: it has no snapshot on
    // any wire and no turn of its own. Every other hidden block — a user
    // message someone hid, a reply they set aside, a tool record — is
    // still skipped here exactly as before, because those are content a
    // person hid and the run that follows them must not see it.
    if (block.hidden && !isReasoningBlock(block)) continue;
    const kind = registry[block.kind];
    if (!kind) {
      throw new Error(`no kind registered for block kind: ${block.kind}`);
    }
    if (!kind.context) continue;
    const ctx = snapshotContext(graph, id, registry, { context: true });
    const wire = wireOf(block, kind, ctx);
    if (wire?.wire === "reasoning") {
      // Reasoning starts an assistant turn rather than riding on the one
      // above it, so the turn this reasoning follows is finished. Where the
      // blocks record turns (see `WirePart.toolCall.turn`) that is what
      // groups calls, and this only says the thought begins a message of its
      // own; where they do not — a graph written before turns were kept — this
      // is the one signal left, and it is worth having: a model that called
      // three tools in one message thought once and called three times (one
      // reasoning block, three tool blocks with nothing between them), while a
      // model that thought again between calls sent a message per call. Both
      // look identical in the graph unless this closes the turn, and reading
      // the sequence as one batch moves every call and its result ahead of the
      // reasoning that produced it.
      reasoning = joinReasoning(reasoning, wire.text);
      open = null;
      openTurn = null;
      continue;
    }
    if (wire?.wire === "toolCall") {
      const call = { id: `call_${++calls}`, name: wire.name, args: wire.args };
      // Same message as the turn still open, or a message the turn did not
      // name: the call belongs to it. A different turn is a different
      // message, and the open turn is finished whether or not it ever named
      // itself — which is what keeps a run of single-call messages from being
      // read as one message that called the same tools in parallel.
      const continues =
        open !== null &&
        (wire.turn === undefined ||
          openTurn === null ||
          openTurn === wire.turn);
      if (open !== null && continues) {
        if (wire.turn !== undefined && openTurn === null) openTurn = wire.turn;
        open.toolCalls = [...(open.toolCalls ?? []), call];
      } else {
        // A turn that called a tool without saying anything first. The
        // provider had an assistant message with no content then, and the
        // replay needs one too, or the call has nowhere to hang.
        open = {
          role: "assistant",
          content: "",
          reasoning: takeReasoning(),
          toolCalls: [call],
        };
        openTurn = wire.turn ?? null;
        messages.push(open);
      }
      messages.push({
        role: "tool",
        content: wire.result,
        toolCallId: call.id,
        // The pictures belong to the answer, not to the call: the request
        // builder attaches them as the user turn the wire put after this
        // message. See `WirePart` and `attachToolImages` in `context-wire.ts`.
        ...(wire.images?.length ? { images: [...wire.images] } : {}),
      });
      continue;
    }
    // Anything that is not one of these two is a turn of its own, and closes
    // the assistant turn above it as surely as it would on the wire.
    open = null;
    openTurn = null;
    for (const message of messagesOfBlock(graph, id, registry)) {
      if (!message.content.trim() && !message.images?.length) continue;
      if (message.role === "developer") {
        const previous = messages[messages.length - 1];
        if (
          previous &&
          previous.role === "developer" &&
          !previous.toolCalls &&
          !previous.toolCallId
        ) {
          previous.content = previous.content
            ? `${previous.content}\n\n${message.content}`
            : message.content;
          if (message.images?.length) {
            previous.images = [...(previous.images ?? []), ...message.images];
          }
          continue;
        }
        messages.push({ ...message });
        continue;
      }
      if (message.role === "assistant") {
        const turn: ContextMessage = { ...message, reasoning: takeReasoning() };
        messages.push(turn);
        open = turn;
        openTurn = null;
        continue;
      }
      messages.push({ ...message });
    }
  }
  return messages;
}

/**
 * Everything before `id` as the transcript it was a part of: `transcriptOfBlocks`
 * over the same walk `messagesAbove` makes.
 */
export function transcriptAbove(
  graph: BlockGraph,
  id: BlockId,
  registry: KindRegistry,
): ContextMessage[] {
  return transcriptOfBlocks(graph, precedingBlockIds(graph, id), registry);
}
