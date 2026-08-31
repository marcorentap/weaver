"use server";

import { revalidatePath } from "next/cache";
import { getStore } from "@/lib/store";
import { schemaMessage } from "@/lib/schema-error";

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
  value: string,
): Promise<{ error: string | null }> {
  const store = getStore();
  const block = store.loadGraph(graphId).blocks[blockId];
  if (!block) return { error: "block no longer exists" };

  try {
    store.putBlocks(graphId, [
      {
        id: block.id,
        kind: block.kind,
        label: block.label,
        createdAt: block.createdAt,
        parents: block.parents,
        children: block.children,
        data: { ...block.data, [name]: value },
      },
    ]);
  } catch (error) {
    return { error: schemaMessage(error) };
  }

  revalidatePath("/chat");
  return { error: null };
}
