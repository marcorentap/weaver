import { ipcMain } from "electron";
import type { Block, BlockGraph, Position } from "@repo/core";
import { ENV_KIND, insertBlock, moveBlock, removeBlock, WEAVER_PWD } from "@repo/core";
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
 * A session the app has opened but not yet persisted anything to. Its row
 * does not exist until the first real write (`saveGraph` or an edit IPC),
 * so an untouched session never touches the database. The default graph it
 * holds is minted at creation, ids and all, so the block Ids the client got
 * from `loadGraph` are exactly the ones the mutation handlers resolve
 * against: a pending session's edit loads this graph, applies the change,
 * and creates the row together with it. Nothing here survives a restart,
 * which is exactly right: an empty session is not worth keeping.
 */
type PendingSession = { name: string; graph: BlockGraph };
const pendingSessions = new Map<string, PendingSession>();

/**
 * The graph the writer side works on: the stored session once its row
 * exists, otherwise the pending default graph. A just-created session has
 * editable blocks (its `environment` block) before any write has happened,
 * and a mutation must resolve against those, not against an empty store.
 */
function sessionGraph(store: Store, graphId: string): BlockGraph {
  return store.getGraph(graphId)
    ? store.loadGraph(graphId)
    : (pendingSessions.get(graphId)?.graph ?? EMPTY_GRAPH);
}

/**
 * Creates the session's row the first time it gets a block, so an empty
 * session never has one. The row is created under the id the client is
 * already navigating by (`createGraph` would mint a fresh one), with the
 * name remembered in `pendingSessions`. A session whose row already exists
 * is left alone, so renames and later writes keep touching the same row.
 */
function ensureSessionRow(store: Store, graphId: string): void {
  if (store.getGraph(graphId)) return;
  store.createGraphAt(graphId, pendingSessions.get(graphId)?.name ?? "New chat");
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
    const blocks = Object.values(apply(sessionGraph(store, graphId)).blocks);
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

/**
 * The default graph a fresh chat starts with: one `environment` block
 * pinning `WEAVER_PWD` to the weaver process's own working directory, so
 * relative media paths and agent runs in the new session resolve exactly
 * where the user launched weaver. A duplicate keeps its source's blocks
 * instead, so this default only lands on genuinely new sessions.
 *
 * It is handed to the view on load and never persisted by itself: a
 * session whose graph is still just the default has not been touched, so
 * no row is created for it. The session's row first materializes with the
 * autosave that fires once the graph is actually dirty (a real edit, a
 * block added), taking the default block along with whatever the user
 * changed. This is what keeps a session the user never touched out of the
 * database entirely.
 */
function defaultGraph(): BlockGraph {
  const now = Date.now();
  const envId = newId();
  const envBlock: Block = {
    id: envId,
    kind: ENV_KIND,
    label: "env",
    createdAt: now,
    modifiedAt: now,
    next: null,
    children: null,
    data: { text: `${WEAVER_PWD}=${process.cwd()}` },
  };
  return { blocks: { [envId]: envBlock }, root: envId };
}

/** Creates a new, empty session (graph). The id it returns, not the name,
 *  is what callers should navigate with. Names are display-only and need
 *  not be unique.
 *
 *  Nothing is written here: a fresh session only gets the default graph
 *  (`environment` block, see `defaultGraph`), minted once and remembered
 *  with the session so the view and the first edit resolve the same block
 *  ids. The row is created together with the first real write (`saveGraph`
 *  or any edit IPC), under the name remembered in `pendingSessions`. */
function createChatSession(name: string): CreateSessionResult {
  const id = newId();
  pendingSessions.set(id, { name, graph: defaultGraph() });
  return { error: null, id };
}

/**
 * Forks a session into a brand-new one: same name plus a "copy" suffix,
 * same blocks under fresh ids, so the copy's tree stays independent of the
 * original's as either one is edited later. The copy's row is written right
 * away (the source is a listed session, so it has content), and the copy -
 * like any written session - shows up in the sessions list.
 */
function duplicateChatSession(sourceId: string): CreateSessionResult {
  const store = getStore();
  const source = store.getGraph(sourceId);
  const name = source ? `${source.name} copy` : "New chat";
  const id = newId();
  pendingSessions.set(id, { name, graph: defaultGraph() });
  try {
    const blocks = Object.values(store.loadGraph(sourceId).blocks);
    if (blocks.length === 0) {
      // The source has no content (a pending, never-written session): the
      // copy is just an empty session under its own name, pending until its
      // first block, exactly like `createChatSession`.
      return { error: null, id };
    }
    const remap = new Map(blocks.map((block) => [block.id, newId()]));
    const copied: BlockInput[] = blocks.map((block) => ({
      id: remap.get(block.id)!,
      kind: block.kind,
      label: block.label,
      createdAt: block.createdAt,
      next: block.next ? remap.get(block.next) : null,
      children: block.children ? remap.get(block.children) : null,
      data: structuredClone(block.data),
      hidden: block.hidden,
    }));
    ensureSessionRow(store, id);
    store.writeGraph(id, copied);
    pendingSessions.delete(id);
    return { error: null, id };
  } catch (error) {
    pendingSessions.delete(id);
    return { error: schemaMessage(error), id: null };
  }
}

/** Renames a session in place with a new (not necessarily unique) name.
 *  The graph and blocks are unchanged. */
function renameChatSession(graphId: string, name: string): MutationResult {
  if (pendingSessions.has(graphId)) {
    // The row does not exist yet, so there is nothing to rename: remember
    // the new name (keeping the pending graph) and let `ensureSessionRow`
    // use it at the first write.
    const pending = pendingSessions.get(graphId)!;
    pendingSessions.set(graphId, { name, graph: pending.graph });
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
        pendingSessions.get(graphId)?.name ??
        "New chat";
      pendingSessions.set(graphId, { name, graph: defaultGraph() });
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
 *
 * A pending session (a name remembered, no row yet) loads the default
 * graph rather than nothing, so a fresh chat shows its `environment` block
 * without any write having happened; only a real edit makes the first save
 * materialize the row. A session with no row and no pending name, or none
 * at all, is empty and renders as "no session". */
function loadGraph(session?: string): LoadGraphResult {
  const store = getStore();

  // A session with no blocks is not a session worth keeping. Since rows are
  // now only written together with their first block, any empty row here is
  // a leftover from before that, so drop it — except the one being opened,
  // which the client still owns (removing its row would strand a live tab
  // against a rowless graph its writes could not reach).
  for (const graph of store.listGraphs()) {
    if (session !== undefined && graph.id === session) continue;
    if (Object.keys(store.loadGraph(graph.id).blocks).length === 0) {
      store.deleteGraph(graph.id);
    }
  }

  const sessions: ChatSessionSummary[] = store
    .listGraphs()
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .map(({ id, name, modifiedAt }) => ({ id, name, modifiedAt }));
  const wanted = typeof session === "string" ? session : sessions[0]?.id;

  // A session the client just opened may have no row and no write yet; only
  // a name. It is a session to the user all the same, so report it and let
  // the first real write create its row.
  const active = wanted ? store.getGraph(wanted) : undefined;
  let open: { id: string; name: string } | null = null;
  if (active) {
    open = { id: active.id, name: active.name };
  } else if (wanted) {
    const pending = pendingSessions.get(wanted);
    if (pending) open = { id: wanted, name: pending.name };
  }
  const graph = active
    ? store.loadGraph(active.id)
    : open
      ? (pendingSessions.get(open.id)?.graph ?? EMPTY_GRAPH)
      : EMPTY_GRAPH;

  return { graph, sessions, session: open };
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
  ipcMain.handle("chat:duplicateChatSession", (_event, graphId: string) =>
    duplicateChatSession(graphId),
  );
  ipcMain.handle("chat:deleteChatSession", (_event, graphId: string) =>
    deleteChatSession(graphId),
  );
  ipcMain.handle("chat:saveGraph", (_event, graphId: string, blocks: BlockInput[]) =>
    saveGraph(graphId, blocks),
  );
}
