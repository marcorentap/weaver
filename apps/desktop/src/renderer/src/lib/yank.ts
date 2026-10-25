import { z } from "zod";
import { childIds, findParent, getBlock, newBlock } from "@repo/core";
import type {
  Block,
  BlockData,
  BlockGraph,
  BlockId,
  Position,
} from "@repo/core";

/**
 * Where the yank register lives between runs of the app. A plain settings
 * row, like everything else the renderer keeps for itself: the register has
 * to outlive a chat session and the window itself, so it cannot be component
 * state, and it is not a conversation, so it does not belong in the graph.
 */
const REGISTER_KEY = "weaver.yank";

/**
 * One yanked block, with whatever was nested inside it, as plain data. Ids
 * are deliberately absent: a paste mints new ones, so a register entry is
 * the block's content and shape only and can be pasted into any session —
 * which is the whole point of the register being separate from the graph it
 * came out of.
 */
export type YankedBlock = {
  kind: string;
  label: string;
  data: BlockData;
  hidden?: boolean;
  asked?: boolean;
  children: YankedBlock[];
};

const yankedBlockSchema: z.ZodType<YankedBlock> = z.lazy(() =>
  z.object({
    kind: z.string(),
    label: z.string(),
    data: z.record(z.string(), z.unknown()),
    hidden: z.boolean().optional(),
    asked: z.boolean().optional(),
    children: z.array(yankedBlockSchema),
  }),
);

const registerSchema = z.object({
  /** What was yanked, in the order it will be pasted back. */
  blocks: z.array(yankedBlockSchema),
  /** Epoch ms of the yank, for nothing but a human reading the row. */
  at: z.number(),
});

export type YankedRegister = z.infer<typeof registerSchema>;

/**
 * A yanked block walked into the shape the keymap pastes: a real `Block`
 * with a fresh id, and the same tree of children under it. Nothing is
 * inserted yet — the caller walks this in order, because a child can only be
 * linked once its parent exists in the graph.
 */
export type PendingBlock = { block: Block; children: PendingBlock[] };

/**
 * The register, newest-known. Held in memory after the first read so a paste
 * keypress never waits on a round trip before it can tell whether there is
 * anything to paste; the settings read behind it is once per window.
 */
let cached: YankedRegister | null = null;
/** Whether `cached` is the answer, including when the answer is "nothing
 *  yanked yet": an empty register must not send every paste back to the
 *  settings row. */
let loaded = false;
let loading: Promise<YankedRegister | null> | null = null;

/**
 * The register as last written, or null when nothing has been yanked since
 * the app was installed. The in-memory copy is authoritative once loaded —
 * the only writer is this module — so a second call is free.
 */
export function loadYank(): Promise<YankedRegister | null> {
  if (loaded) return Promise.resolve(cached);
  loading ??= window.api.settings
    .get(REGISTER_KEY)
    .then((raw) => parseRegister(raw))
    .catch(() => null)
    .then((register) => {
      cached = register;
      loaded = true;
      loading = null;
      return register;
    });
  return loading;
}

/**
 * A stored value that no longer parses — written by a much older build, or
 * by hand — reads as an empty register rather than throwing at the keypress.
 * A yank is the least precious thing the app holds; refusing to paste is
 * better than a dialog about JSON.
 */
function parseRegister(raw: string | null): YankedRegister | null {
  if (!raw) return null;
  try {
    const parsed = registerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Yank `ids` — each block with everything nested inside it — into the
 * register, replacing whatever was there (vim's unnamed register has one
 * slot, and a person who yanks twice expects the second yank to win).
 *
 * A block whose ancestor is in the same selection is dropped: it is already
 * coming along inside that ancestor's subtree, and keeping both would paste
 * it twice. A selection can hold both because `v` selects rendered rows, and
 * an expanded container shows its children as rows of their own.
 */
export async function yankBlocks(
  graph: BlockGraph,
  ids: BlockId[],
): Promise<YankedRegister> {
  const wanted = new Set(ids);
  const top = ids.filter((id) => {
    if (!graph.blocks[id]) return false;
    for (
      let at = findParent(graph, id);
      at !== null;
      at = findParent(graph, at)
    ) {
      if (wanted.has(at)) return false;
    }
    return true;
  });
  const register: YankedRegister = {
    blocks: top.map((id) => yankedTree(graph, id)),
    at: Date.now(),
  };
  cached = register;
  loaded = true;
  // Fire and forget: a yank is done the moment the register is in memory,
  // and a failed write costs the register only across a restart.
  void window.api.settings
    .set(REGISTER_KEY, JSON.stringify(register))
    .catch(() => {});
  return register;
}

/** One block and its subtree as `YankedBlock`s, in chain order. */
function yankedTree(graph: BlockGraph, id: BlockId): YankedBlock {
  const block = getBlock(graph, id);
  return {
    kind: block.kind,
    label: block.label,
    data: structuredClone(block.data),
    ...(block.hidden ? { hidden: true } : {}),
    ...(block.asked ? { asked: true } : {}),
    children: childIds(graph, id).map((child) => yankedTree(graph, child)),
  };
}

/**
 * The register as pasteable blocks. Every block gets a fresh id and a fresh
 * `createdAt`: a pasted copy is a new block that happens to hold the same
 * content, and reusing an id the source session still holds would collide
 * the moment the two ever met.
 */
export function instantiate(register: YankedRegister): PendingBlock[] {
  return register.blocks.map((entry) => instantiateOne(entry));
}

function instantiateOne(entry: YankedBlock): PendingBlock {
  // `asked` and `hidden` are facts about the block's content rather than
  // about the place it held in its old graph, so a copy keeps both: what was
  // yanked is what is pasted back. `newBlock` has a field for one of them.
  const block: Block = {
    ...newBlock({
      id: crypto.randomUUID(),
      kind: entry.kind,
      label: entry.label,
      data: structuredClone(entry.data),
      ...(entry.hidden ? { hidden: true } : {}),
    }),
    ...(entry.asked ? { asked: true } : {}),
  };
  return {
    block,
    children: entry.children.map((child) => instantiateOne(child)),
  };
}

/**
 * Walk `blocks` into the graph through `add`, starting at `at`, and return
 * the id of the first one added (null when the graph refused the very first
 * insert). Later blocks land after the one before them at each level, so the
 * pasted tree reads exactly as the yanked one did.
 *
 * `add` is the live graph's `addBlock`, taken as an argument rather than
 * imported so the walk stays a pure tree operation: it is the caller that
 * knows how a block joins *this* graph, and how its undo stack deals with a
 * paste of many blocks.
 */
export function pasteYanked(
  blocks: PendingBlock[],
  at: Position,
  add: (block: Block, at: Position) => boolean,
): BlockId | null {
  let first: BlockId | null = null;
  let anchor = at;
  for (const entry of blocks) {
    if (!insertOne(entry, anchor, add)) break;
    first ??= entry.block.id;
    anchor = { parentId: anchor.parentId, afterId: entry.block.id };
  }
  return first;
}

function insertOne(
  entry: PendingBlock,
  at: Position,
  add: (block: Block, at: Position) => boolean,
): boolean {
  if (!add(entry.block, at)) return false;
  let anchor: Position = { parentId: entry.block.id, afterId: null };
  for (const child of entry.children) {
    if (!insertOne(child, anchor, add)) return false;
    anchor = { parentId: entry.block.id, afterId: child.block.id };
  }
  return true;
}
