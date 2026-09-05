import { ipcMain } from "electron";
import type { Block, BlockGraph, Position } from "@repo/core";
import { insertBlock, moveBlock, removeBlock } from "@repo/core";
import type { BlockInput } from "@repo/store";
import { getStore } from "../lib/store.js";
import { schemaMessage } from "../lib/schema-error.js";
import type {
  ChatSessionSummary,
  CreateSessionResult,
  LoadGraphResult,
  MutationResult,
} from "../../shared/ipc-contract.js";

const EMPTY_GRAPH: BlockGraph = { blocks: {}, root: null };

/**
 * Structural edits are load → apply a core tree operation → write the result
 * back, because moving one block rewrites its neighbors' links too: the tree
 * is only ever valid as a whole, so a write of anything less than the whole
 * graph would have to reproduce that surgery by hand.
 */
function rewrite(
  graphId: string,
  apply: (graph: BlockGraph) => BlockGraph,
): MutationResult {
  const store = getStore();
  try {
    store.writeGraph(
      graphId,
      Object.values(apply(store.loadGraph(graphId)).blocks),
    );
  } catch (error) {
    return { error: schemaMessage(error) };
  }
  return { error: null };
}

/** Deletes a block and everything nested under it — a container's contents
 *  exist only inside it, so they go with it rather than being cut loose. */
function deleteChatBlock(graphId: string, id: string): MutationResult {
  return rewrite(graphId, (graph) => removeBlock(graph, id));
}

/**
 * Writes one field of a block's state. The write is validated against the
 * kind's schema inside the store, so a bad value is rejected rather than
 * persisted — its message is returned for the editor to show.
 */
function updateBlockField(
  graphId: string,
  blockId: string,
  name: string,
  value: string | number,
): MutationResult {
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
function createChatBlock(
  graphId: string,
  input: BlockInput,
  at: Position,
): MutationResult {
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
function moveChatBlock(
  graphId: string,
  blockId: string,
  at: Position,
): MutationResult {
  return rewrite(graphId, (graph) => moveBlock(graph, blockId, at));
}

/** Creates a new, empty session (graph) — the id it returns, not the name,
 *  is what callers should navigate with. Names are display-only and need
 *  not be unique: the id is what identifies a session. */
function createChatSession(name: string): CreateSessionResult {
  const store = getStore();
  try {
    return { error: null, id: store.createGraph(name).id };
  } catch (error) {
    return { error: schemaMessage(error), id: null };
  }
}

/** Renames a session in place — same graph, same blocks, new (not
 *  necessarily unique) name. */
function renameChatSession(graphId: string, name: string): MutationResult {
  try {
    getStore().renameGraph(graphId, name);
  } catch (error) {
    return { error: schemaMessage(error) };
  }
  return { error: null };
}

/** Deletes a session (graph) and every block in it, outright — there is no
 *  undo, same as deleting a block. */
function deleteChatSession(graphId: string): MutationResult {
  try {
    getStore().deleteGraph(graphId);
  } catch (error) {
    return { error: schemaMessage(error) };
  }
  return { error: null };
}

/**
 * Persists the client's whole live graph in one write — autosave and the
 * manual `s` → `s` shortcut both call this. The client is the source of
 * truth once a session is loaded (hook ticks land there first, at whatever
 * cadence a timer names), so this is a plain "flush what I already have",
 * not a merge.
 */
function saveGraph(graphId: string, blocks: BlockInput[]): MutationResult {
  try {
    getStore().writeGraph(graphId, blocks);
  } catch (error) {
    return { error: schemaMessage(error) };
  }
  return { error: null };
}

/**
 * Loads a session's graph plus the session list — the data the chat view
 * needs on mount. A session is a graph; "recent" is its last write. `session`
 * resolves an explicit id or falls back to the most recently modified one.
 */
function loadGraph(session?: string): LoadGraphResult {
  const store = getStore();

  const sessions: ChatSessionSummary[] = store
    .listGraphs()
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .map(({ id, name, modifiedAt }) => ({ id, name, modifiedAt }));

  const wanted = typeof session === "string" ? session : sessions[0]?.id;
  const active = wanted ? store.getGraph(wanted) : undefined;
  const graph = active ? store.loadGraph(active.id) : EMPTY_GRAPH;

  return {
    graph,
    sessions,
    session: active ? { id: active.id, name: active.name } : null,
  };
}

export function registerChatHandlers(): void {
  ipcMain.handle("chat:loadGraph", (_event, session?: string) =>
    loadGraph(session),
  );
  ipcMain.handle("chat:deleteChatBlock", (_event, graphId: string, id: string) =>
    deleteChatBlock(graphId, id),
  );
  ipcMain.handle(
    "chat:updateBlockField",
    (_event, graphId: string, blockId: string, name: string, value: string | number) =>
      updateBlockField(graphId, blockId, name, value),
  );
  ipcMain.handle(
    "chat:createChatBlock",
    (_event, graphId: string, input: BlockInput, at: Position) =>
      createChatBlock(graphId, input, at),
  );
  ipcMain.handle(
    "chat:moveChatBlock",
    (_event, graphId: string, blockId: string, at: Position) =>
      moveChatBlock(graphId, blockId, at),
  );
  ipcMain.handle("chat:createChatSession", (_event, name: string) =>
    createChatSession(name),
  );
  ipcMain.handle("chat:renameChatSession", (_event, graphId: string, name: string) =>
    renameChatSession(graphId, name),
  );
  ipcMain.handle("chat:deleteChatSession", (_event, graphId: string) =>
    deleteChatSession(graphId),
  );
  ipcMain.handle("chat:saveGraph", (_event, graphId: string, blocks: BlockInput[]) =>
    saveGraph(graphId, blocks),
  );
}
