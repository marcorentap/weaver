import { ipcMain } from "electron";
import type { Block, BlockGraph, Position } from "@repo/core";
import { insertBlock, moveBlock, removeBlock } from "@repo/core";
import { newId, type BlockInput, type Store } from "@repo/store";
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
 * Sessions the app has opened but not yet written a block to. A name typed
 * into a fresh session is remembered here until its first real write creates
 * the row (`saveGraph`). Nothing here survives a restart, which is exactly
 * right: an empty session is not worth keeping, so the database never sees
 * it.
 */
const pendingSessions = new Map<string, string>();

/**
 * Creates the session's row the first time it gets a block, so an empty
 * session never has one. The row is created under the id the client is
 * already navigating by (`createGraph` would mint a fresh one), with the
 * name the user typed when the session was opened, remembered in
 * `pendingSessions`. A session whose row already exists is left alone, so
 * renames and later writes keep touching the same row.
 */
function ensureSessionRow(store: Store, graphId: string): void {
  if (store.getGraph(graphId)) return;
  store.createGraphAt(graphId, pendingSessions.get(graphId) ?? "New chat");
}

/**
 * Structural edits load the graph, apply a core tree operation, and write
 * the result back. Moving one block rewrites its neighbors' links too: the
 * tree is only ever valid as a whole, so a write of anything less than the
 * whole graph would have to reproduce that surgery by hand.
 */
function rewrite(
  graphId: string,
  apply: (graph: BlockGraph) => BlockGraph,
): MutationResult {
  const store = getStore();
  try {
    const blocks = Object.values(apply(store.loadGraph(graphId)).blocks);
    if (blocks.length === 0) {
      // Deleting the last block empties the session, the same outcome as an
      // empty autosave: the session is no longer a session, so its row goes
      // with it. `deleteGraph` is a no-op when the row never existed.
      pendingSessions.delete(graphId);
      store.deleteGraph(graphId);
      return { error: null };
    }
    // The first block of a newly opened session reaches this (via
    // `createChatBlock`) before any autosave materializes the row, and
    // `writeGraph`'s block rows are foreign-keyed to a graph row that must
    // exist, so create it here rather than failing the write.
    const created = !store.getGraph(graphId);
    ensureSessionRow(store, graphId);
    try {
      store.writeGraph(graphId, blocks);
    } catch (error) {
      // A row created just for this write must not survive a rejected
      // write (validation can still fail inside `writeGraph`).
      if (created) store.deleteGraph(graphId);
      throw error;
    }
    pendingSessions.delete(graphId);
  } catch (error) {
    return { error: schemaMessage(error) };
  }
  return { error: null };
}

/** Deletes a block and everything nested under it. A container's contents
 *  exist only inside it, so they go with it rather than being cut loose. */
function deleteChatBlock(graphId: string, id: string): MutationResult {
  return rewrite(graphId, (graph) => removeBlock(graph, id));
}

/**
 * Writes one field of a block's state. The write is validated against the
 * kind's schema inside the store, so a bad value is rejected rather than
 * persisted. Its message is returned for the editor to show.
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

/** Renames a block's label in place. The label is a top-level field, not
 *  part of `data`, so it lives outside `updateBlockField`. */
function updateBlockLabel(
  graphId: string,
  blockId: string,
  label: string,
): MutationResult {
  return rewrite(graphId, (graph) => {
    const block = graph.blocks[blockId];
    if (!block) throw new Error("block no longer exists");
    return {
      ...graph,
      blocks: {
        ...graph.blocks,
        [blockId]: { ...block, label, modifiedAt: Date.now() },
      },
    };
  });
}

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

/** Relinks a block at `at`, taking whatever is nested under it along. This
 *  covers the whole of the `J`/`K` reorder and `>`/`<` nest keys. */
function moveChatBlock(
  graphId: string,
  blockId: string,
  at: Position,
): MutationResult {
  return rewrite(graphId, (graph) => moveBlock(graph, blockId, at));
}

/** Creates a new, empty session (graph). The id it returns, not the name,
 *  is what callers should navigate with. Names are display-only and need
 *  not be unique. */
function createChatSession(name: string): CreateSessionResult {
  const id = newId();
  pendingSessions.set(id, name);
  return { error: null, id };
}

/** Renames a session in place with a new (not necessarily unique) name.
 *  The graph and blocks are unchanged. */
function renameChatSession(graphId: string, name: string): MutationResult {
  if (pendingSessions.has(graphId)) {
    // The row does not exist yet, so there is nothing to rename: remember
    // the new name and let `ensureSessionRow` use it at the first write.
    pendingSessions.set(graphId, name);
    return { error: null };
  }
  try {
    getStore().renameGraph(graphId, name);
  } catch (error) {
    return { error: schemaMessage(error) };
  }
  return { error: null };
}

/** Deletes a session (graph) and every block in it, outright. There is no
 *  undo, same as deleting a block. */
function deleteChatSession(graphId: string): MutationResult {
  try {
    getStore().deleteGraph(graphId);
    pendingSessions.delete(graphId);
  } catch (error) {
    return { error: schemaMessage(error) };
  }
  return { error: null };
}

/**
 * Persists the client's whole live graph in one write. Autosave and the
 * manual `s` shortcut both call this. Once a session is loaded the client
 * is the source of truth, since hook ticks land there first at whatever
 * cadence a timer names, so this is a plain "flush what I already have",
 * not a merge.
 *
 * An empty session is never written: the row is created together with its
 * first block, and a write that empties a session (deleting its last
 * block, or a session that never got one) drops the session instead, so
 * the database never holds a session with nothing in it.
 */
function saveGraph(graphId: string, blocks: BlockInput[]): MutationResult {
  const store = getStore();
  try {
    if (blocks.length === 0) {
      // Deleting the last block ends a session's persisted life: no row is
      // left behind, since an empty session is not saved. Keep its name as
      // pending, so the same id still resolves to a real session and a
      // fresh block recreates the row, instead of surfacing a rowless
      // session the view could no longer write.
      const name =
        store.getGraph(graphId)?.name ??
        pendingSessions.get(graphId) ??
        "New chat";
      pendingSessions.set(graphId, name);
      store.deleteGraph(graphId);
      return { error: null };
    }
    const created = !store.getGraph(graphId);
    ensureSessionRow(store, graphId);
    try {
      store.writeGraph(graphId, blocks);
    } catch (error) {
      // `writeGraph` validates the tree and the kinds' schemas, which can
      // still reject a write. A row created just for this failed write
      // must not be left behind.
      if (created) store.deleteGraph(graphId);
      throw error;
    }
    pendingSessions.delete(graphId);
  } catch (error) {
    return { error: schemaMessage(error) };
  }
  return { error: null };
}

/**
 * Loads a session's graph plus the session list, the data the chat view
 * needs on mount. A session is a graph; "recent" is its last write.
 * `session` resolves an explicit id or falls back to the most recently
 * modified one.
 */
function loadGraph(session?: string): LoadGraphResult {
  const store = getStore();

  const summarize = (): ChatSessionSummary[] =>
    store
      .listGraphs()
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .map(({ id, name, modifiedAt }) => ({ id, name, modifiedAt }));

  const wanted = typeof session === "string" ? session : summarize()[0]?.id;

  // A session with no blocks is not a session worth keeping. Since rows are
  // now only written together with their first block, any empty row here is
  // a leftover from before that, so drop it — except the one being opened,
  // which the client still owns (removing its row would strand a live tab
  // against a rowless graph its writes could not reach).
  for (const graph of store.listGraphs()) {
    if (graph.id === wanted) continue;
    if (Object.keys(store.loadGraph(graph.id).blocks).length === 0) {
      store.deleteGraph(graph.id);
    }
  }

  // A session the client just opened may have no row and no write yet; only
  // a name. It is a session to the user all the same, so report it and let
  // the first real write create its row.
  const active = wanted ? store.getGraph(wanted) : undefined;
  let open: { id: string; name: string } | null = null;
  if (active) {
    open = { id: active.id, name: active.name };
  } else if (wanted) {
    const name = pendingSessions.get(wanted);
    if (name) open = { id: wanted, name };
  }
  const graph = active ? store.loadGraph(active.id) : EMPTY_GRAPH;

  return { graph, sessions: summarize(), session: open };
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
    "chat:updateBlockLabel",
    (_event, graphId: string, blockId: string, label: string) =>
      updateBlockLabel(graphId, blockId, label),
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
