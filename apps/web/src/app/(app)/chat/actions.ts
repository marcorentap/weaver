"use server";

import { revalidatePath } from "next/cache";
import type { Block, BlockGraph, Position } from "@repo/core";
import { insertBlock, moveBlock, removeBlock } from "@repo/core";
import type { BlockInput } from "@repo/store";
import { getStore } from "@/lib/store";
import { schemaMessage } from "@/lib/schema-error";

/**
 * Structural edits are load → apply a core tree operation → write the result
 * back, because moving one block rewrites its neighbors' links too: the tree
 * is only ever valid as a whole, so a write of anything less than the whole
 * graph would have to reproduce that surgery by hand.
 */
function rewrite(
  graphId: string,
  apply: (graph: BlockGraph) => BlockGraph,
): { error: string | null } {
  const store = getStore();
  try {
    store.writeGraph(
      graphId,
      Object.values(apply(store.loadGraph(graphId)).blocks),
    );
  } catch (error) {
    return { error: schemaMessage(error) };
  }
  revalidatePath("/chat");
  return { error: null };
}

/** Deletes a block and everything nested under it — a container's contents
 *  exist only inside it, so they go with it rather than being cut loose. */
export async function deleteChatBlock(
  graphId: string,
  id: string,
): Promise<{ error: string | null }> {
  return rewrite(graphId, (graph) => removeBlock(graph, id));
}

/**
 * Writes one field of a block's state. The write is validated against the
 * kind's schema inside the store, so a bad value is rejected rather than
 * persisted — its message is returned for the editor to show.
 */
export async function updateBlockField(
  graphId: string,
  blockId: string,
  name: string,
  value: string | number,
): Promise<{ error: string | null }> {
  return rewrite(graphId, (graph) => {
    const block = graph.blocks[blockId];
    if (!block) throw new Error("block no longer exists");
    return {
      ...graph,
      blocks: {
        ...graph.blocks,
        [blockId]: { ...block, data: { ...block.data, [name]: value } },
      },
    };
  });
}

/**
 * Creates one block from an already-built `BlockInput` — the client picks the
 * kind, id and label, this places it at `at` and persists the resulting tree.
 */
export async function createChatBlock(
  graphId: string,
  input: BlockInput,
  at: Position,
): Promise<{ error: string | null }> {
  const now = Date.now();
  const block: Block = {
    id: input.id,
    kind: input.kind,
    label: input.label,
    createdAt: input.createdAt,
    modifiedAt: now,
    next: null,
    children: null,
    data: input.data ?? {},
  };
  return rewrite(graphId, (graph) => insertBlock(graph, block, at));
}

/** Relinks a block at `at`, taking whatever is nested under it along — the
 *  whole of the `J`/`K` reorder and `>`/`<` nest keys. */
export async function moveChatBlock(
  graphId: string,
  blockId: string,
  at: Position,
): Promise<{ error: string | null }> {
  return rewrite(graphId, (graph) => moveBlock(graph, blockId, at));
}

/** Creates a new, empty session (graph), addressed by name like every
 *  other — but the id it returns, not the name, is what callers should
 *  navigate with. */
export async function createChatSession(
  name: string,
): Promise<{ error: string | null; id: string | null }> {
  const store = getStore();
  if (store.findGraph(name)) {
    return { error: `a session named "${name}" already exists`, id: null };
  }

  let id: string;
  try {
    id = store.createGraph(name).id;
  } catch (error) {
    return { error: schemaMessage(error), id: null };
  }

  revalidatePath("/chat");
  return { error: null, id };
}

/** Renames a session in place — same graph, same blocks, new address. */
export async function renameChatSession(
  graphId: string,
  name: string,
): Promise<{ error: string | null }> {
  const store = getStore();
  const taken = store.findGraph(name);
  if (taken && taken.id !== graphId) {
    return { error: `a session named "${name}" already exists` };
  }

  try {
    store.renameGraph(graphId, name);
  } catch (error) {
    return { error: schemaMessage(error) };
  }

  revalidatePath("/chat");
  return { error: null };
}

/** Deletes a session (graph) and every block in it, outright — there is no
 *  undo, same as deleting a block. */
export async function deleteChatSession(
  graphId: string,
): Promise<{ error: string | null }> {
  try {
    getStore().deleteGraph(graphId);
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
    getStore().writeGraph(graphId, blocks);
  } catch (error) {
    return { error: schemaMessage(error) };
  }

  revalidatePath("/chat");
  return { error: null };
}
