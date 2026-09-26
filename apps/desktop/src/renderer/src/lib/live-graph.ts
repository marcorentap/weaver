import type {
  Block,
  BlockData,
  BlockGraph,
  BlockId,
  ContextImage,
  ContextMessage,
  HookContext,
  Position,
} from "@repo/core";
import {
  childIds,
  findParent,
  findPrevSibling,
  insertBlock,
  lastChildId,
  mergedEnvironment,
  messagesAbove,
  messagesOfBlock,
  messagesOfBlocks,
  messagesOfGraph,
  moveBlock as moveBlockCore,
  removeBlock,
  snapshotBlock,
  TEXT_KIND,
} from "@repo/core";
// Type-only: `@repo/store` reaches for node:sqlite, so a value import here
// would drag the whole persistence layer into the renderer bundle.
import type { BlockInput } from "@repo/store";
import { kinds } from "@shared/blocks/kinds.js";
import { ASSISTANT_KIND, TOOL_KIND } from "@plugins/rich-media";
import { streamInference } from "@/lib/inference";
import type { ThinkingLevel } from "@shared/agent-events.js";

/**
 * The instruction the session-title run sends the model. The session travels
 * above it as a single `developer` message holding the whole graph as a JSON
 * list of `{ role, content }` turns, so the model reads the session as data
 * to label rather than as a conversation it is part of and should continue.
 * Read-only: the title is returned to the caller, nothing is written or
 * appended.
 */
const TITLE_PROMPT = [
  "The JSON above is a session's messages, each with a role and its content.",
  "Name the session: a short label, a few words, that tells what it is about.",
  "Read it from the content, not a generic phrase.",
  "Reply with only the title, no preamble or quotes.",
].join("\n");

/** Hard output cap for the session-title run. The instruction asks for a few
 *  words, but a chatty model will happily answer with a paragraph, and that
 *  paragraph becomes the session's name. The cap is enforced by the provider
 *  (the request's own `maxTokens`), not by trimming the answer afterwards, so
 *  the model's own stream ends early instead of running on past the name. */
const TITLE_MAX_TOKENS = 24;

/**
 * The instruction a summarization run sends the model. The run is isolated:
 * only the target's own turns go along as the run's context — never the graph
 * around it — so the model reads the content the user pointed at and nothing
 * else. Kept here, not in a block, because the action is the summary itself —
 * the target is the thing to compress, not a reason to answer. The material
 * precedes the instruction in the request, so the instruction points above.
 */
const SUMMARIZE_PROMPT = [
  "Summarize the text above.",
  "Write in plain style: short, matter-of-fact sentences, no filler, no cliches, no formulaic transition phrases, no decorative adjectives.",
  "Make it self-contained: inline the names, numbers, dates, results, and decisions themselves. A summary that merely points at information, like a C pointer, sends the reader fetching; when the text only references something (a commit, a file, a link), say what it says or does so the summary reads true on its own.",
  "If the text only makes sense with context, open with a short background section saying what it is part of, what it changes, or why it exists.",
  "Reply with only the summary, no preamble.",
].join("\n");

/** Connection and resource-loading settings shared by inference and
 *  summarization runs. What pi's `DefaultResourceLoader` loads for the run
 *  maps straight onto `AgentRunRequest`'s wire names; see that type for the
 *  defaults the main process applies when a flag is omitted. */
type RunConnection = {
  endpoint: string;
  apiKey: string;
  model: string;
  tools?: string[];
  /** The provider detected from `endpoint`, and its saved settings.
   *  Passed through to the main process untouched; see
   *  `shared/provider-routing.ts`. */
  providerId?: string;
  providerSettings?: Record<string, string>;
  /** Reasoning effort the run asks the model for, pi-ai's levels; blank
   *  leaves the SDK's default. Goes to the main process as the request's
   *  own `thinkingLevel`. */
  thinkingLevel?: string;
  /** Cap on how many output tokens the run's model may produce, or 0 for
   *  no cap. Goes to the main process as the request's own `maxTokens`. */
  maxTokens?: number;
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  /** Treat the run as a plain LLM call instead of an agent run: no session,
   *  tools, system prompt, or resource loading in the main process. The
   *  summarization run sets this; inference never does. */
  plain?: boolean;
};

export type LiveGraphSnapshot = {
  graph: BlockGraph;
  /** Changed locally since the last successful save. */
  dirty: boolean;
  /** Epoch ms of the last successful save, or null before the first one. */
  savedAt: number | null;
  /** Blocks with a hook or an inference run currently in flight. That is a
   *  run's only visible state while it is still running, since both a
   *  hook's and an inference run's own state update land all at once when
   *  they resolve. */
  running: ReadonlySet<BlockId>;
  /**
   * Blocks a running inference is parked on: the questions it raised that
   * nobody has answered yet. A run stops inside the tool call that asked,
   * so nothing else about it moves until one of these is answered — which is
   * why the answer is the one edit that stays open on a run's own output
   * (see `lockedBlockIds`). Empty whenever no run is waiting on anything.
   */
  waiting: ReadonlySet<BlockId>;
  /** For each running inference, the block it is currently appending
   *  after: the run's anchor until the first reply lands, then whichever
   *  reply landed most recently. This is only ever a block the run itself
   *  appended (or the anchor), never a pre-existing sibling further down
   *  the chain, so it is tracked directly rather than derived by walking
   *  `next` pointers, which would run off the end of the whole chain. */
  appendTails: ReadonlyMap<BlockId, BlockId>;
  /** Whether an undo/redo can run right now. False while a run is in
   *  flight, since rewinding the graph out from under a streaming run
   *  would strand its appends. */
  canUndo: boolean;
  canRedo: boolean;
};

export type LiveGraph = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LiveGraphSnapshot;
  /**
   * Run a block's named hook and commit whatever state comes back. Entirely
   * kind-agnostic. It looks up `block.kind` in the registry and calls
   * whatever hook was asked for. It has no idea what a "timer" or an
   * "ISS location" is, and never needs to.
   */
  runHook: (id: BlockId, hook: string, arg?: unknown) => Promise<void>;
  /**
   * The global "run inference" action. Any block, not just one of a
   * particular kind, can anchor a run. Context is everything above `id`,
   * turn by turn (`messagesAbove`); the prompt is `id`'s own content, or its
   * last user turn when the block holds a whole exchange (`messagesOfBlock`).
   * A block someone just typed becomes the last user turn. Results land
   * as siblings appended right after `id`, chained one after the next in
   * the order they streamed in, never nested under it. A re-run adds
   * another reply rather than replacing the last one.
   *
   * A run can also stop partway, on a question one of its tools raised (see
   * `waiting` in the snapshot): the tool call waits there until the block
   * that question landed in is answered, and only then does the run stream
   * its next turn. Everything the run had already appended stays put.
   *
   * Lives on the engine, not a component, so the fetch stream survives the
   * view that started it unmounting (switching tabs and back). It keeps
   * appending into this graph regardless of who, if anyone, is watching.
   */
  runInference: (id: BlockId, options: RunConnection) => Promise<void>;
  /**
   * The same engine as `runInference`, but the model compresses `take` —
   * the block under the cursor, or the whole visual selection — into a
   * short summary instead of replying to the conversation above it. The
   * target's blocks are the run's whole context, sent as the turns they
   * already are (a person's message as a user turn, a run's reply as an
   * assistant one, the rest as developer material) with the instruction as
   * the prompt after them; none of the graph context goes
   * along, so the summary is of the block in isolation, short and accurate
   * for a reader scanning many blocks to keep up. `anchor` is where the
   * summary lands and which block the run locks; single-block runs pass the
   * same id as the only element of `take`, selection runs pass the range
   * with its last id as the anchor, so the summary appends right after the
   * selection. The answer lands in a block labeled "summary". `s` (default
   * settings) and `S` (custom settings) in the block and selection menus
   * drive it via the summarization settings, with blank fields falling back
   * to the inference ones. Whether the run mounts the agent is the
   * `summAgent` setting's call: on, it is an agent run (tools, skills,
   * extensions, the loaded defaults); off, `plain` rides the connection, so
   * the call is plain read-only compression.
   */
  summarize: (
    anchor: BlockId,
    take: BlockId[],
    options: RunConnection,
  ) => Promise<void>;
  /** Name the whole session from its graph context: a plain read-only LLM
   *  call that flattens the visible graph, asks the model for a short
   *  title, and returns it — or null when the graph is empty, the call
   *  fails, or the model answers with nothing. Nothing is written or
   *  appended; the caller renames the session to the result (`R` in the
   *  session menu does). */
  generateTitle: (options: RunConnection) => Promise<string | null>;
  /** Apply an already-persisted field edit locally, so the row reflects it
   *  without waiting on a round trip back down. */
  updateField: (id: BlockId, name: string, value: string | number) => void;
  /**
   * Replace a block's whole state in one local edit, for shapes a single
   * field write cannot express (a kind's option list, say). The caller has
   * already validated the new data against the kind; this marks the graph
   * dirty so the next autosave persists it, the same path hiding a block
   * takes. No-ops if `id` is locked.
   */
  updateBlockData: (id: BlockId, data: BlockData) => void;
  /** Apply an already-persisted label edit locally. The label lives at the
   *  top level of a block, not inside `data`. */
  updateLabel: (id: BlockId, label: string) => void;
  /** Toggle a block's `hidden` flag locally, so it drops out of the rows
   *  and of the next agent serialization immediately; the autosave the
   *  dirty flag triggers persists it (and replays the whole graph) just
   *  like any other local edit. No-ops, returning false, if `id` is
   *  locked. */
  setHidden: (id: BlockId, hidden: boolean) => boolean;
  /** Abort the inference anchored at `id`, if one is in flight. */
  abortRun: (id: BlockId) => boolean;
  /**
   * Undo the most recent user change, restored one graph snapshot at a
   * time. No-ops, returning false, when there is nothing to undo or a run
   * is in flight. Every user-initiated commit (add, move, delete, field
   * and label edits, hiding, whole inference runs) records a snapshot
   * before mutating, so `u` / `ctrl+r` step through a session's own edit
   * history. Hook-generated churn — a timer tick, a scheduled fetch — is
   * deliberately outside the history: it has no single author to fault.
   */
  undo: () => boolean;
  /** Step forward again through an undone change, if one was undone and no
   *  newer edit was made since (a new edit clears the redo stack, the
   *  standard editor contract). No-ops, returning false, when there is
   *  nothing to redo or a run is in flight. */
  redo: () => boolean;
  /**
   * Run `mutate` as a single undoable action: however many calls it makes
   * to the engine's own mutating methods, exactly one history entry is
   * recorded, so a single `u` rewinds all of them together. Multi-block
   * actions (delete a visual selection, hide a range, group blocks under a
   * new one) use this so an undo doesn't hop one block at a time. Nested
   * groups collapse into the outermost one; the call runs synchronously.
   */
  group: <T>(mutate: () => T) => T;
  /** Link an already-persisted new block into the tree at `at`. No-ops,
   *  returning false, when `at.afterId` is locked. */
  addBlock: (block: Block, at: Position) => boolean;
  /** Relink a block, and everything nested under it, at `at`. That is the
   *  whole of "moving" a block, reorder and nesting alike. No-ops,
   *  returning false, if `id` or the `at.afterId` destination is locked. */
  moveBlock: (id: BlockId, at: Position) => boolean;
  /** Drop a block and everything nested under it, optimistically. No-ops,
   *  returning false, if `id` is locked. */
  deleteBlock: (id: BlockId) => boolean;
  /** Whether `id` is a block a still-running inference has appended so
   *  far (see `lockedBlockIds`). Every other mutating method above checks
   *  this itself; callers never need to precompute it before calling in. */
  isLocked: (id: BlockId) => boolean;
  toBlockInputs: () => BlockInput[];
  markSaved: () => void;
  markSaveFailed: () => void;
};

/**
 * Every block a still-running inference has appended so far: from right
 * after its anchor up to its current tail (`appendTails`). Content there
 * is being written by the run itself, so this is the one place that
 * decides what counts as locked. The engine's own mutating methods and
 * any UI deciding whether to offer an edit both call this, rather than
 * each re-deriving their own notion of "still streaming".
 *
 * An anchor whose tail is still itself has not appended anything yet, so
 * it contributes nothing locked; walking from its `next` in that case
 * would run off the end of the whole chain instead of stopping at the
 * run's own content, since there is no run content yet to stop at.
 *
 * Blocks the run is *waiting* on are exempt. Locking is about content the
 * run is still writing; a question a run parked on is the one piece of its
 * output that exists to be edited, and the edit is what sets it going again
 * (see `defineKind.resume`), so it has to be reachable by the same paths
 * every other block is. Everything the run wrote around it stays locked.
 */
export function lockedBlockIds(
  graph: BlockGraph,
  appendTails: ReadonlyMap<BlockId, BlockId>,
  waiting: ReadonlySet<BlockId> = new Set(),
): Set<BlockId> {
  const locked = new Set<BlockId>();
  for (const [anchor, tail] of appendTails) {
    if (tail === anchor) continue;
    let cur = graph.blocks[anchor]?.next ?? null;
    while (cur !== null) {
      if (!waiting.has(cur)) locked.add(cur);
      if (cur === tail) break;
      cur = graph.blocks[cur]?.next ?? null;
    }
  }
  return locked;
}

/**
 * A block graph that lives entirely in the browser once created. A hook (a
 * timer's tick, an ISS fetch, the engine doesn't know or care which) mutates
 * it directly and notifies subscribers immediately, so an update lands on
 * screen the instant it resolves rather than at the next poll or
 * revalidation.
 *
 * Deliberately plain, non-React state, built with `useSyncExternalStore` in
 * mind (same shape as `lib/settings`'s module-level store). Mutation and
 * `Date.now()` are exactly what a live graph needs, and keeping both out of
 * any component's own render path is what keeps a page using this
 * compatible with the React Compiler, which assumes render is pure.
 */
export function createLiveGraph(initial: BlockGraph): LiveGraph {
  let snapshot: LiveGraphSnapshot = {
    graph: initial,
    dirty: false,
    savedAt: null,
    running: new Set(),
    waiting: new Set(),
    appendTails: new Map(),
    canUndo: false,
    canRedo: false,
  };
  const listeners = new Set<() => void>();
  /** Past graph states, oldest first, each pushed just before a user edit
   *  rewrites the tree. They are cheap to keep: every commit builds a new
   *  graph that structurally shares everything it did not touch, so a
   *  snapshot is a few references, not a copy. `redoStack` holds the
   *  graphs an undo stepped away from, and is discarded the moment a new
   *  user edit lands, the standard editor contract. */
  const undoStack: BlockGraph[] = [];
  const redoStack: BlockGraph[] = [];
  const HISTORY_LIMIT = 100;
  const hasUndo = () => undoStack.length > 0 && snapshot.running.size === 0;
  const hasRedo = () => redoStack.length > 0 && snapshot.running.size === 0;
  /** Nesting depth of the currently open undo group, and whether it has
   *  already recorded its single history entry. Reset when a group opens
   *  from depth 0, so nested `group` calls collapse into the outermost
   *  unit. See `group` on the live engine. */
  let groupDepth = 0;
  let groupRecorded = false;
  /** Remember the current graph as the point an undo would return to, ahead
   *  of a user-initiated mutation, and invalidate any redo branch. Inside
   *  an open group only the first mutation records, capturing the
   *  pre-action state; everything after it stays under the same entry. */
  function pushUndo() {
    if (groupDepth > 0) {
      if (groupRecorded) return;
      groupRecorded = true;
    }
    undoStack.push(snapshot.graph);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }
  /** Cancel handle per in-flight inference, so an abort can be aimed at a
   *  specific block rather than being a global stop. */
  const runningAborts = new Map<BlockId, () => void>();
  /**
   * The waits a still-running inference has raised, keyed by the block that
   * holds the question: the wire id its answer goes back under, the anchor of
   * the run it belongs to, and that run's own answer callback. Hanging off
   * the engine rather than the run is what lets a state edit anywhere reach
   * them — see `resolveWaits`.
   */
  const pendingWaits = new Map<
    BlockId,
    {
      id: string;
      runId: BlockId;
      answer: (id: string, value: string | null) => void;
    }
  >();

  function emit() {
    for (const listener of listeners) listener();
  }

  function commit(graph: BlockGraph, dirty: boolean) {
    snapshot = {
      ...snapshot,
      graph,
      dirty,
      canUndo: hasUndo(),
      canRedo: hasRedo(),
    };
    emit();
    // A commit is one of the few moments an answer can appear, whatever path
    // wrote it — a kind's own dialog, a field edit, a hook's result — so this
    // is where a parked run is released. Costs nothing when none is parked,
    // which is nearly always.
    resolveWaits();
  }

  /**
   * Release every wait whose block now holds something to release it with.
   * Nothing but the kind's own `resume` decides that: the text it reads out of
   * the block's state is what the tool call behind the wait receives, and a
   * kind that says null is a block the person has not answered yet. A block
   * that was deleted instead of answered releases its run with no answer,
   * which is how a tool hears that the question is gone rather than waiting
   * forever on a form that no longer exists.
   */
  function resolveWaits() {
    if (pendingWaits.size === 0) return;
    for (const [blockId, wait] of [...pendingWaits]) {
      const block = snapshot.graph.blocks[blockId];
      const value = block
        ? (kinds[block.kind]?.resume?.(block.data) ?? null)
        : null;
      if (block && value === null) continue;
      pendingWaits.delete(blockId);
      setWaiting(blockId, false);
      wait.answer(wait.id, value);
    }
  }

  function setRunning(id: BlockId, active: boolean) {
    const next = new Set(snapshot.running);
    if (active) next.add(id);
    else next.delete(id);
    // A run starting rewrites the tree from here on, so its future result
    // invalidates any pending redo, exactly like a user edit would.
    if (active) redoStack.length = 0;
    // Flags read the set being installed, not the stale `snapshot.running`
    // still marked as in flight.
    snapshot = {
      ...snapshot,
      running: next,
      canUndo: undoStack.length > 0 && next.size === 0,
      canRedo: redoStack.length > 0 && next.size === 0,
    };
    emit();
  }

  function setAppendTail(id: BlockId, tail: BlockId | null) {
    const next = new Map(snapshot.appendTails);
    if (tail === null) next.delete(id);
    else next.set(id, tail);
    snapshot = { ...snapshot, appendTails: next };
    emit();
  }

  /** Mark a block as one a run is parked on, or release it from that state.
   *  Separate from `setRunning`, which is about the run's own anchor: a run
   *  is both running and waiting while a question of its is open, and the
   *  two say different things. */
  function setWaiting(id: BlockId, waiting: boolean) {
    const next = new Set(snapshot.waiting);
    if (waiting) next.add(id);
    else next.delete(id);
    snapshot = { ...snapshot, waiting: next };
    emit();
  }

  async function runHook(
    id: BlockId,
    hook: string,
    arg?: unknown,
  ): Promise<void> {
    const block = snapshot.graph.blocks[id];
    if (!block) return; // Stale reference (deleted target).
    const kind = kinds[block.kind];
    if (!kind) return;
    // A hook already running on this block finishes on its own; a second
    // trigger, a stray key repeat or an overlapping timer tick, is a no-op
    // rather than a second run racing the first over the same children.
    if (snapshot.running.has(id)) return;

    const ctx: HookContext = {
      id,
      graph: snapshot.graph,
      registry: kinds,
      call: async (targetId, name, callArg) => {
        try {
          await runHook(targetId, name, callArg);
        } catch (error) {
          console.error(
            `hook "${hook}" on ${block.kind} ${id} called ${name} on ${targetId}, which failed:`,
            error,
          );
        }
      },
      addBlock: (childKind, data, label, parentId = id) => {
        // Reads the live snapshot, not `ctx.graph`. A hook that cleared its
        // children first must append to what that left behind.
        const graph = snapshot.graph;
        const newId = crypto.randomUUID();
        const now = Date.now();
        const child: Block = {
          id: newId,
          kind: childKind,
          label,
          createdAt: now,
          modifiedAt: now,
          next: null,
          children: null,
          data,
        };
        commit(
          insertBlock(graph, child, {
            parentId,
            afterId: lastChildId(graph, parentId),
          }),
          true,
        );
        return newId;
      },
      clearChildren: (parentId = id) => {
        let graph = snapshot.graph;
        const children = childIds(graph, parentId);
        if (children.length === 0) return;
        for (const childId of children) graph = removeBlock(graph, childId);
        commit(graph, true);
      },
    };

    setRunning(id, true);
    let data: BlockData;
    try {
      data = await kind.call(block.data, hook, ctx, arg);
    } finally {
      setRunning(id, false);
    }
    // No liveness check here on purpose. React StrictMode's dev-only
    // mount→cleanup→mount replays a component's effects once without ever
    // recreating this engine (it is cached in the live-graph registry, not
    // component state), so a "destroyed on cleanup" flag would go
    // permanently true on that first fake unmount and silently swallow
    // every real update for the rest of the session. A result landing
    // after the view holding this engine is gone just updates an object
    // nothing reads anymore. Harmless.
    const current = snapshot.graph.blocks[id];
    if (!current) return; // Deleted while the hook was in flight.
    commit(
      {
        ...snapshot.graph,
        blocks: {
          ...snapshot.graph.blocks,
          [id]: { ...current, data, modifiedAt: Date.now() },
        },
      },
      true,
    );
  }

  /** The shared engine behind both runs: stream one reply and append its
   *  result blocks. `id` is the anchor — where the reply lands and which
   *  block the run locks. An inference run prompts with the anchor's own
   *  content and sends everything above it as turn-by-turn context; a
   *  summarization run passes `take` (the block, or the selected range, to
   *  compress) and sends those blocks' turns as the whole context, with the
   *  instruction after them, so the summary is of the target alone.
   *  `answerKind` is the kind the reply's text lands in, with
   *  `answerLabel` as its label: an `assistant` block for inference (its own
   *  kind, so a later run reads the reply as the model's own earlier turn),
   *  a `text` block labeled "summary" for a summarization. */
  async function runAgentText(
    id: BlockId,
    {
      endpoint,
      apiKey,
      model,
      tools = [],
      providerId,
      providerSettings,
      thinkingLevel,
      maxTokens,
      noExtensions,
      noSkills,
      noPromptTemplates,
      noThemes,
      noContextFiles,
      plain,
      take,
      answerKind,
      answerLabel,
    }: RunConnection & {
      /** The blocks whose content a summarization run compresses, sent as
       *  the run's context in place of the graph above; absent for an
       *  inference run, which uses `id`'s own content instead. */
      take?: BlockId[];
      /** The kind the reply's text lands in. */
      answerKind: string;
      /** The reply block's label. */
      answerLabel: string;
    },
  ): Promise<void> {
    const block = snapshot.graph.blocks[id];
    if (!block) return; // Stale reference (deleted target).
    if (snapshot.running.has(id)) return; // Already running for this block.

    // The whole run is one undo unit: the graph exactly as it was when the
    // run began. Everything the run appends (reasoning, replies, tool
    // results, even a pre-flight error block) rewinds together with a
    // single `u` afterwards, rather than leaving one history entry per
    // streamed delta.
    pushUndo();
    const parentId = findParent(snapshot.graph, id);
    const append = (
      kind: string,
      data: BlockData,
      label: string,
      hidden?: boolean,
    ) => {
      const newId = crypto.randomUUID();
      const now = Date.now();
      const child: Block = {
        id: newId,
        kind,
        label,
        createdAt: now,
        modifiedAt: now,
        next: null,
        children: null,
        data,
        ...(hidden ? { hidden: true } : {}),
      };
      // Where the next block goes is the run's own tail, not a position
      // remembered here: while a run is parked on a question, the block it is
      // parked on is the tail *and* editable, so it can be discarded before
      // the run resumes — which repairs the tail out from under this (see
      // `deleteBlock`). Falling back to the anchor covers the rest: a run
      // whose own insertion point somehow vanished still appends into the
      // graph rather than throwing into whoever is streaming events at it.
      const tail = snapshot.appendTails.get(id) ?? id;
      const afterId = snapshot.graph.blocks[tail] ? tail : id;
      commit(insertBlock(snapshot.graph, child, { parentId, afterId }), true);
      setAppendTail(id, newId);
      return newId;
    };
    // A run's deltas land in two blocks: the model's reasoning labeled
    // "thinking" and its answer labeled per `answerLabel`, in `answerKind`
    // (an assistant block for inference, a text block for a summarization).
    // Both reasoning and reply are plain text — text is text whether it is a
    // chain of thought or an answer — but they are separate blocks, because
    // the reply is the answer the user asked for and the reasoning is the
    // work that produced it. Each is null between messages, so the first
    // delta of a new one starts a fresh block instead of gluing onto whatever
    // came before it, such as a tool result, a displayed block, or an earlier
    // reply in the same run. Reasoning also
    // starts hidden (`enter` → `h` shows it): it stays out of the rendered
    // list and out of the agent's context until the user unfolds it, so the
    // reply reads as the answer without the chain of thought behind it.
    let thinkingId: BlockId | null = null;
    let replyId: BlockId | null = null;
    let thinkingText = "";
    let replyText = "";
    /** Push `text` into an already-open block, or start one if its stream
     *  has not yet. `id` is written back through the same `snapshot` so a
     *  run of updates each sees the previous one. */
    const patchText = (id: BlockId, text: string) => {
      const current = snapshot.graph.blocks[id];
      if (!current) return; // Deleted mid-stream.
      commit(
        {
          ...snapshot.graph,
          blocks: {
            ...snapshot.graph.blocks,
            [id]: { ...current, data: { text }, modifiedAt: Date.now() },
          },
        },
        true,
      );
    };
    // A run's tool calls each occupy one `tool` block, opened by the wire's
    // `tool_start` and streamed into by `tool_delta`. `toolBlocks` maps the
    // wire id (main-process-assigned, unique per run) to the block id, so
    // the calls of one turn that run in parallel each land in their own
    // block.
    const toolBlocks = new Map<string, BlockId>();
    const patchTool = (id: BlockId, output: string, ok?: boolean) => {
      const current = snapshot.graph.blocks[id];
      if (!current) return; // Deleted mid-stream.
      commit(
        {
          ...snapshot.graph,
          blocks: {
            ...snapshot.graph.blocks,
            [id]: {
              ...current,
              data: {
                ...current.data,
                output,
                ...(ok === undefined ? {} : { ok }),
              },
              modifiedAt: Date.now(),
            },
          },
        },
        true,
      );
    };
    const updateThinking = () => {
      if (thinkingId === null) {
        thinkingId = append(
          TEXT_KIND,
          { text: thinkingText },
          "thinking",
          true,
        );
      } else {
        patchText(thinkingId, thinkingText);
      }
    };
    const updateReply = () => {
      if (replyId === null) {
        replyId = append(answerKind, { text: replyText }, answerLabel);
      } else {
        patchText(replyId, replyText);
      }
    };
    const resetStreaming = () => {
      thinkingId = null;
      replyId = null;
      thinkingText = "";
      replyText = "";
    };
    // Pre-flight failures land as an appended error block too, and never
    // set `running`, because there is nothing in flight to show a spinner
    // for. `append` records the block as the run's tail; since no stream
    // ever starts and the `finally` below never runs, that tail would stick
    // and hold the error block (and everything after it) locked for good.
    // Clear it right back so the error is editable and deletable like any
    // other block.
    const appendPreflightError = (text: string) => {
      append(TEXT_KIND, { text }, "error");
      setAppendTail(id, null);
    };
    if (!endpoint || !apiKey || !model) {
      appendPreflightError(
        "missing endpoint, API key, or model. Check settings",
      );
      return;
    }
    // What the agent reads. An inference run is the block's own content as
    // the run's last turn, with everything above it sent ahead of it turn by
    // turn: what a person wrote as user turns, what earlier runs answered as
    // assistant turns, and every other block — tool calls, files,
    // environment, plain text — as developer material for the model to work
    // from. A summarization run is the same shape, but its context is the
    // target block or blocks rather than the graph above: the target's turns
    // go along as the run's context, in `take` order, and the fixed
    // instruction follows as the run's prompt. No graph context goes along,
    // so the model compresses the block in isolation instead of re-deriving
    // the conversation around it, and a target that holds more than one
    // voice reads as the exchange it is rather than as a run-together string.
    let prompt: string;
    let context: ContextMessage[];
    // Pictures the block being run holds. They travel with the run's own
    // turn rather than in `context`, which is the material above it: an
    // image block someone runs inference on is the thing being asked about,
    // not background. A kind whose last turn is not the user's own (an
    // unanswered question, or an image block, which has no turns at all)
    // still contributes whatever it shows.
    let promptImages: ContextImage[] = [];
    if (take) {
      context = messagesOfBlocks(snapshot.graph, take, kinds);
      if (context.length === 0) {
        appendPreflightError(
          take.length > 1
            ? "nothing to summarize — the selected blocks are empty"
            : "nothing to summarize — the block is empty",
        );
        return;
      }
      prompt = SUMMARIZE_PROMPT;
    } else {
      // Everything above the block, then the block's own turns. The last of
      // them is what the run is prompted with, because a request has to end
      // on a user turn for the model to have something to answer — and for
      // most kinds that last turn is the block's document, exactly as a
      // prompt has always been. A kind whose one block holds more than one
      // voice brings its earlier turns along: an answered question is the
      // question as an assistant turn, then the person's answer as the
      // prompt. Its earlier turns go ahead of it rather than inside the
      // document, so what the model reads is the exchange the block holds
      // and not one message with a question and an answer run together.
      const above = messagesAbove(snapshot.graph, id, kinds);
      const own = messagesOfBlock(snapshot.graph, id, kinds);
      const anchor = kinds[block.kind]?.turns ? own : [];
      const last = anchor[anchor.length - 1];
      // A block whose turns do not end on the user's own — a question nobody
      // has answered yet, which holds the question and nothing after it —
      // has no turn a request can be prompted with. It falls back to the
      // document, which at least reads as the thing being asked about.
      if (last && last.role === "user") {
        prompt = last.content;
        promptImages = last.images ?? [];
        context = [...above, ...anchor.slice(0, -1)];
      } else {
        prompt = snapshotBlock(snapshot.graph, id, kinds);
        promptImages = own.flatMap((turn) => turn.images ?? []);
        context = above;
      }
      if (!prompt.trim()) {
        appendPreflightError("block is empty. Nothing to send");
        return;
      }
    }
    // The environment the block sees, walked up the graph the same way the
    // agent's own context is. The main process turns `WEAVER_PWD` into the
    // agent's working directory and hands the rest to the agent's tools, so
    // "where am I" and "what's my environment" stay the block's own view.
    const env = mergedEnvironment(snapshot.graph, id);

    setRunning(id, true);
    setAppendTail(id, id);
    try {
      let failure: string | null = null;
      const { done, cancel, answer } = streamInference(
        {
          endpoint,
          apiKey,
          model,
          context,
          prompt,
          ...(promptImages.length > 0 ? { promptImages } : {}),
          tools,
          providerId,
          providerSettings,
          thinkingLevel: thinkingLevel as ThinkingLevel | undefined,
          maxTokens,
          env,
          noExtensions,
          noSkills,
          noPromptTemplates,
          noThemes,
          noContextFiles,
          plain,
        },
        (event) => {
          if (event.type === "thinking_delta") {
            thinkingText += event.text;
            updateThinking();
          } else if (event.type === "thinking") {
            // Deltas already streamed this into the block; only a
            // non-streaming provider's whole-reasoning event needs to set
            // it here, ahead of the `text` event that follows.
            if (thinkingId === null) {
              thinkingText = event.text;
              updateThinking();
            }
          } else if (event.type === "text_delta") {
            replyText += event.text;
            updateReply();
          } else if (event.type === "text") {
            // Deltas already streamed this message in, so the reply block
            // already holds it; this only ends the stream rather than
            // appending a duplicate. If no deltas arrived (a non-streaming
            // provider, or text that came with no preceding delta at all),
            // append the message whole, exactly as before deltas existed.
            if (replyId === null) {
              replyText = event.text;
              append(answerKind, { text: replyText }, answerLabel);
            }
            resetStreaming();
          } else if (event.type === "tool_start") {
            resetStreaming();
            const blockId = append(
              TOOL_KIND,
              { name: event.name, args: event.args, output: "", ok: true },
              event.name,
            );
            toolBlocks.set(event.id, blockId);
          } else if (event.type === "tool_delta") {
            // The main process diffs each partial snapshot before sending,
            // so this is the call's output appended so far; the authoritative
            // whole still arrives with the closing `tool` event.
            const blockId = toolBlocks.get(event.id);
            if (blockId === undefined) return;
            const current = snapshot.graph.blocks[blockId];
            if (!current) return; // Deleted mid-stream.
            const output =
              typeof current.data.output === "string"
                ? current.data.output
                : "";
            patchTool(blockId, output + event.text);
          } else if (event.type === "tool") {
            resetStreaming();
            const blockId = toolBlocks.get(event.id);
            if (blockId !== undefined) {
              toolBlocks.delete(event.id);
              // Authoritative: whatever the deltas said, this is what the
              // call finished with.
              patchTool(blockId, event.output, event.ok);
            } else {
              // No `tool_start` preceded this (a call whose start was
              // skipped, or a remote that never streams), so append the
              // block whole, as before streaming existed.
              append(
                TOOL_KIND,
                {
                  name: event.name,
                  args: event.args,
                  output: event.output,
                  ok: event.ok,
                },
                event.name,
              );
            }
          } else if (event.type === "block") {
            resetStreaming();
            const target = kinds[event.kind];
            if (!target) return;
            try {
              target.parse(event.data);
            } catch {
              return;
            }
            append(event.kind, event.data, event.label);
          } else if (event.type === "wait") {
            // The run is stopped inside the tool call that raised this, so
            // the question has to be both visible and answerable. A kind the
            // renderer does not know, or data its own schema rejects, leaves
            // nobody able to see the question, let alone answer it, so the
            // run is released straight away with no answer instead of being
            // held open by a block that never appeared. Otherwise the block
            // lands and the engine watches it: whatever edit later makes its
            // kind's `resume` say something is what answers the tool.
            resetStreaming();
            const target = kinds[event.kind];
            let parsed = false;
            if (target) {
              try {
                target.parse(event.data);
                parsed = true;
              } catch {
                // Treated exactly like an unknown kind, below.
              }
            }
            if (!parsed) {
              answer(event.id, null);
              return;
            }
            const blockId = append(event.kind, event.data, event.label);
            pendingWaits.set(blockId, { id: event.id, runId: id, answer });
            setWaiting(blockId, true);
            // A block that is answered as it lands — a tool handing over a
            // state that already holds one — parks nothing: the same check
            // every later edit goes through releases it here and now, so the
            // run is never held open by a question nobody has left to ask.
            resolveWaits();
          } else if (event.type === "error") {
            failure = event.message;
          }
        },
      );
      runningAborts.set(id, cancel);
      await done;
      if (failure !== null) append(TEXT_KIND, { text: failure }, "error");
    } catch (error) {
      append(
        TEXT_KIND,
        { text: error instanceof Error ? error.message : String(error) },
        "error",
      );
    } finally {
      // A run that ended with a question still open — cancelled while the
      // user was deciding, or errored around it — leaves nothing to answer,
      // so the block stops being marked as the thing holding the run up.
      // Whatever the tool call painted behind it was already released by
      // whoever ended the run (see `agent:run:cancel`).
      for (const [blockId, wait] of [...pendingWaits]) {
        if (wait.runId !== id) continue;
        pendingWaits.delete(blockId);
        setWaiting(blockId, false);
      }
      runningAborts.delete(id);
      setRunning(id, false);
      setAppendTail(id, null);
    }
  }

  async function runInference(
    id: BlockId,
    connection: RunConnection,
  ): Promise<void> {
    return runAgentText(id, {
      ...connection,
      answerKind: ASSISTANT_KIND,
      answerLabel: "assistant",
    });
  }

  /** Summarize `take` — one block, or the whole visual selection — in
   *  isolation. `anchor` is where the summary lands and which block the run
   *  locks: pass the same block for a single-block run, the selection's last
   *  id for a range, so the summary appends right after the selection. The
   *  target's content is the whole prompt (`SUMMARIZE_PROMPT` + content); no
   *  graph context goes along. */
  async function summarize(
    anchor: BlockId,
    take: BlockId[],
    connection: RunConnection,
  ): Promise<void> {
    return runAgentText(anchor, {
      ...connection,
      take,
      answerKind: TEXT_KIND,
      answerLabel: "summary",
    });
  }

  /** Generate a short title for the whole session from its graph context.
   *  The visible graph — `messagesOfGraph`'s scope, the same material an
   *  inference run reads as context — is serialized to a JSON list of
   *  `{ role, content }` turns so a person's message, a run's reply and the
   *  material between them keep their roles without reading as a conversation
   *  to continue, and a plain read-only LLM call names the session from it —
   *  no tools, no graph writes, no reply blocks appended. The graph itself is untouched,
   *  so nothing streams in and nothing needs locking or undo. Returns the
   *  produced title, or null when the graph is empty, the call fails, or
   *  the model answers with nothing. The session menu's `R` action drives
   *  it with the inference settings and renames the session to the result.
   */
  async function generateTitle(
    connection: RunConnection,
  ): Promise<string | null> {
    const messages = messagesOfGraph(snapshot.graph, kinds);
    if (messages.length === 0) return null;
    // The session is handed over as serialized data, not as the run's own
    // turns: sent turn-by-turn, the model reads a conversation still in
    // progress and is as likely to answer its last message as to name it.
    // As JSON in one `developer` message it is unmistakably material to
    // label, and the ask above it stays the only turn to answer.
    const context = [
      {
        role: "developer" as const,
        content: JSON.stringify(messages, null, 2),
      },
    ];
    let title = "";
    let failed = false;
    const { done } = streamInference(
      {
        ...connection,
        tools: connection.tools ?? [],
        // After the spread, so a title run is capped no matter what the
        // caller's connection carries (the inference defaults allow 8192).
        maxTokens: TITLE_MAX_TOKENS,
        // Reasoning off, likewise after the spread. The cap above is spent
        // by whatever the model streams, and thinking is streamed too, so an
        // inherited level can burn the whole budget before the first word of
        // the title arrives — leaving nothing to name the session with. A
        // name is a read of the material, not a problem to reason about.
        thinkingLevel: "off" satisfies ThinkingLevel,
        context,
        prompt: TITLE_PROMPT,
        plain: true,
      },
      (event) => {
        if (event.type === "text_delta") {
          title += event.text;
        } else if (event.type === "text" && !title) {
          // A non-streaming provider sends the whole answer in one `text`
          // event; keep the accumulated deltas otherwise.
          title = event.text;
        } else if (event.type === "error") {
          failed = true;
        }
      },
    );
    await done;
    if (failed) return null;
    const result = title.trim();
    return result.length > 0 ? result : null;
  }

  function abortRun(id: BlockId): boolean {
    const abort = runningAborts.get(id);
    if (!abort) return false;
    abort();
    return true;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    runHook,
    abortRun,
    runInference,
    summarize,
    generateTitle,
    isLocked: (id) =>
      lockedBlockIds(
        snapshot.graph,
        snapshot.appendTails,
        snapshot.waiting,
      ).has(id),
    updateField(id, name, value) {
      if (
        lockedBlockIds(
          snapshot.graph,
          snapshot.appendTails,
          snapshot.waiting,
        ).has(id)
      )
        return;
      const current = snapshot.graph.blocks[id];
      if (!current) return;
      pushUndo();
      commit(
        {
          ...snapshot.graph,
          blocks: {
            ...snapshot.graph.blocks,
            [id]: {
              ...current,
              data: { ...current.data, [name]: value },
              modifiedAt: Date.now(),
            },
          },
        },
        snapshot.dirty,
      );
    },
    updateBlockData(id, data) {
      if (
        lockedBlockIds(
          snapshot.graph,
          snapshot.appendTails,
          snapshot.waiting,
        ).has(id)
      )
        return;
      const current = snapshot.graph.blocks[id];
      if (!current) return;
      pushUndo();
      commit(
        {
          ...snapshot.graph,
          blocks: {
            ...snapshot.graph.blocks,
            [id]: { ...current, data, modifiedAt: Date.now() },
          },
        },
        true,
      );
    },
    updateLabel(id, label) {
      if (
        lockedBlockIds(
          snapshot.graph,
          snapshot.appendTails,
          snapshot.waiting,
        ).has(id)
      )
        return;
      const current = snapshot.graph.blocks[id];
      if (!current) return;
      pushUndo();
      commit(
        {
          ...snapshot.graph,
          blocks: {
            ...snapshot.graph.blocks,
            [id]: { ...current, label, modifiedAt: Date.now() },
          },
        },
        snapshot.dirty,
      );
    },
    setHidden(id, hidden) {
      if (
        lockedBlockIds(
          snapshot.graph,
          snapshot.appendTails,
          snapshot.waiting,
        ).has(id)
      )
        return false;
      const current = snapshot.graph.blocks[id];
      if (!current || (current.hidden ?? false) === hidden) return false;
      pushUndo();
      commit(
        {
          ...snapshot.graph,
          blocks: {
            ...snapshot.graph.blocks,
            [id]: { ...current, hidden, modifiedAt: Date.now() },
          },
        },
        true,
      );
      return true;
    },
    addBlock(block, at) {
      if (
        at.afterId &&
        lockedBlockIds(
          snapshot.graph,
          snapshot.appendTails,
          snapshot.waiting,
        ).has(at.afterId)
      )
        return false;
      pushUndo();
      commit(insertBlock(snapshot.graph, block, at), true);
      return true;
    },
    moveBlock(id, at) {
      if (!snapshot.graph.blocks[id]) return false;
      const locked = lockedBlockIds(
        snapshot.graph,
        snapshot.appendTails,
        snapshot.waiting,
      );
      if (locked.has(id) || (at.afterId && locked.has(at.afterId)))
        return false;
      pushUndo();
      commit(moveBlockCore(snapshot.graph, id, at), true);
      return true;
    },
    deleteBlock(id) {
      if (
        lockedBlockIds(
          snapshot.graph,
          snapshot.appendTails,
          snapshot.waiting,
        ).has(id)
      ) {
        return false;
      }
      // A run's tail is where its next block goes, and the one block of its
      // own output it is parked on is editable — including out of the graph.
      // Dropping a tail therefore hands the run the block before it, its own
      // anchor in the worst case, so a run that resumes after its question
      // was discarded appends into a graph that still has an insertion point.
      for (const [anchor, tail] of snapshot.appendTails) {
        if (tail !== id) continue;
        setAppendTail(anchor, findPrevSibling(snapshot.graph, id) ?? anchor);
      }
      pushUndo();
      commit(removeBlock(snapshot.graph, id), true);
      return true;
    },
    undo() {
      if (!hasUndo()) return false;
      while (undoStack.length > 0) {
        const previous = undoStack.pop() as BlockGraph;
        // A run that was cut off before appending anything leaves a
        // history entry pointing at the graph it never changed. Step past
        // those, they have nothing to rewind.
        if (previous === snapshot.graph) continue;
        redoStack.push(snapshot.graph);
        commit(previous, true);
        return true;
      }
      return false;
    },
    redo() {
      if (!hasRedo()) return false;
      const next = redoStack.pop() as BlockGraph;
      undoStack.push(snapshot.graph);
      commit(next, true);
      return true;
    },
    group<T>(mutate: () => T): T {
      if (groupDepth === 0) groupRecorded = false;
      groupDepth++;
      try {
        return mutate();
      } finally {
        groupDepth--;
      }
    },
    // A `Block` is already a valid `BlockInput`; the store ignores the extra
    // `modifiedAt`, which it owns.
    toBlockInputs: () => Object.values(snapshot.graph.blocks),
    markSaved() {
      snapshot = { ...snapshot, dirty: false, savedAt: Date.now() };
      emit();
    },
    markSaveFailed() {
      snapshot = { ...snapshot, dirty: true };
      emit();
    },
  };
}

/**
 * Every block currently asking for a hook of its own to be invoked on a
 * timer, per its kind's `schedule`. Kind-agnostic on purpose. A caller
 * reconciling this against real `setInterval`s never needs to know "timer"
 * exists as a concept, let alone which kind implements it.
 */
export function scheduledHooks(
  graph: BlockGraph,
): { id: BlockId; intervalMs: number; hook: string }[] {
  return Object.values(graph.blocks).flatMap((block) => {
    const schedule = kinds[block.kind]?.schedule(block.data) ?? null;
    return schedule ? [{ id: block.id, ...schedule }] : [];
  });
}
