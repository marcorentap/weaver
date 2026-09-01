"use server";

import { revalidatePath } from "next/cache";
import type { Block, BlockId } from "@repo/core";
import type { BlockInput } from "@repo/store";
import { getStore } from "@/lib/store";
import { schemaMessage } from "@/lib/schema-error";

/** A block, as-is, in the shape `putBlocks` wants — the common case of
 *  rewriting one block's edges or data without touching the rest of it. */
function blockToInput(block: Block, overrides: Partial<BlockInput> = {}): BlockInput {
  return {
    id: block.id,
    kind: block.kind,
    label: block.label,
    createdAt: block.createdAt,
    parents: block.parents,
    children: block.children,
    data: block.data,
    ...overrides,
  };
}

/** Actions offered by the chat block popup. */
export async function deleteChatBlock(id: string): Promise<void> {
  getStore().deleteBlock(id);
  revalidatePath("/chat");
}

/**
 * Writes one field of a block's state. Edges are re-sent unchanged because
 * `putBlocks` replaces them wholesale, and the write is validated against the
 * kind's schema inside the store, so a bad value is rejected rather than
 * persisted — its message is returned for the editor to show.
 */
export async function updateBlockField(
  graphId: string,
  blockId: string,
  name: string,
  value: string | number,
): Promise<{ error: string | null }> {
  const store = getStore();
  const block = store.loadGraph(graphId).blocks[blockId];
  if (!block) return { error: "block no longer exists" };

  try {
    store.putBlocks(graphId, [
      blockToInput(block, { data: { ...block.data, [name]: value } }),
    ]);
  } catch (error) {
    return { error: schemaMessage(error) };
  }

  revalidatePath("/chat");
  return { error: null };
}

/**
 * Creates one block from an already-built `BlockInput` — the client picks
 * the kind, id and `createdAt` (interpolated between its future neighbors),
 * this just persists it. When `parentId` is given the new block is also
 * appended to that block's `children`, which is what makes it render at
 * all: a block absent from every container's children is top-level, but one
 * meant to nest has to be added somewhere.
 */
export async function createChatBlock(
  graphId: string,
  input: BlockInput,
  parentId: BlockId | null,
): Promise<{ error: string | null }> {
  const store = getStore();

  try {
    store.putBlocks(graphId, [input]);
    if (parentId) {
      const parent = store.loadGraph(graphId).blocks[parentId];
      if (parent && !parent.children.includes(input.id)) {
        store.putBlocks(graphId, [
          blockToInput(parent, { children: [...parent.children, input.id] }),
        ]);
      }
    }
  } catch (error) {
    return { error: schemaMessage(error) };
  }

  revalidatePath("/chat");
  return { error: null };
}

/** Reorders one block among its siblings by rewriting its `createdAt` —
 *  see `LiveGraph.setCreatedAt`. Used by the `J`/`K` move keys, and to place
 *  a block moved by `moveChatBlock` within its new container. */
export async function setBlockCreatedAt(
  graphId: string,
  blockId: string,
  createdAt: number,
): Promise<{ error: string | null }> {
  const store = getStore();
  const block = store.loadGraph(graphId).blocks[blockId];
  if (!block) return { error: "block no longer exists" };

  try {
    store.putBlocks(graphId, [blockToInput(block, { createdAt })]);
  } catch (error) {
    return { error: schemaMessage(error) };
  }

  revalidatePath("/chat");
  return { error: null };
}

/**
 * Moves a block between containers — either may be null for top-level — and
 * gives it a new `createdAt` in its new position, for the `>`/`<`
 * nest/unnest keys. Rewrites the old container's `children` to drop it and
 * the new one's to add it; either write is skipped when that side is
 * top-level or unchanged.
 */
export async function moveChatBlock(
  graphId: string,
  blockId: string,
  createdAt: number,
  fromParentId: BlockId | null,
  toParentId: BlockId | null,
): Promise<{ error: string | null }> {
  const store = getStore();

  try {
    const block = store.loadGraph(graphId).blocks[blockId];
    if (!block) return { error: "block no longer exists" };
    store.putBlocks(graphId, [blockToInput(block, { createdAt })]);

    if (fromParentId && fromParentId !== toParentId) {
      const from = store.loadGraph(graphId).blocks[fromParentId];
      if (from) {
        store.putBlocks(graphId, [
          blockToInput(from, {
            children: from.children.filter((id) => id !== blockId),
          }),
        ]);
      }
    }
    if (toParentId && toParentId !== fromParentId) {
      const to = store.loadGraph(graphId).blocks[toParentId];
      if (to && !to.children.includes(blockId)) {
        store.putBlocks(graphId, [
          blockToInput(to, { children: [...to.children, blockId] }),
        ]);
      }
    }
  } catch (error) {
    return { error: schemaMessage(error) };
  }

  revalidatePath("/chat");
  return { error: null };
}

/** Creates a new, empty session (graph), addressed by name like every other. */
export async function createChatSession(
  name: string,
): Promise<{ error: string | null }> {
  const store = getStore();
  if (store.findGraph(name)) {
    return { error: `a session named "${name}" already exists` };
  }

  try {
    store.createGraph(name);
  } catch (error) {
    return { error: schemaMessage(error) };
  }

  revalidatePath("/chat");
  return { error: null };
}

/**
 * Persists the client's whole live graph in one write — autosave and the
 * manual `s` → `s` shortcut both call this. The client is the source of
 * truth once a session is loaded (hook ticks land there first, at whatever
 * cadence a timer names), so this is a plain "flush what I already have",
 * not a merge.
 */
export async function saveGraph(
  graphId: string,
  blocks: BlockInput[],
): Promise<{ error: string | null }> {
  try {
    getStore().putBlocks(graphId, blocks);
  } catch (error) {
    return { error: schemaMessage(error) };
  }

  revalidatePath("/chat");
  return { error: null };
}
