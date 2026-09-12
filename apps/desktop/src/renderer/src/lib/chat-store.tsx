import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { BlockGraph } from "@repo/core";
import type { BlockInput } from "@repo/store";
import { dropLiveGraph } from "@/lib/live-graph-registry";
import type {
  ChatSessionSummary,
  CreateSessionResult,
  LoadGraphResult,
  MutationResult,
} from "@shared/ipc-contract.js";

/**
 * The chat data every chat pane shares: the sessions list and, per session,
 * the seed graph (the default `environment` block on a fresh session, the
 * stored graph the first time a session is opened). It lives at module
 * scope, like `lib/settings`'s store, entirely outside React.
 *
 * Before this store existed each pane re-ran `chat:loadGraph` on mount —
 * the main process swept every stored session's graph and rebuilt the whole
 * list — so a split or a new tab paid a full IPC round trip plus an O(n)
 * database walk before it could render. Now the list loads once at app
 * start, mutations keep it in step locally, and a session's graph is loaded
 * at most once per session (singleflight, shared across panes). A pane
 * mounts against this store: creating a fresh session seeds its graph
 * directly from the create result, so the pane renders with zero IPC.
 *
 * The `sessions` list only shows what is actually persisted: a brand-new
 * session is *pending* (seeded and usable, but it has no row on disk until
 * its first block is written), so it is not listed in the recent-sessions
 * menu. `createChatSession` seeds it for instant pane rendering;
 * `saveChatGraph` lists it the moment the first write lands, and unlists it
 * again when its last block is deleted (main drops empty sessions). A quiet
 * never-edited session never reads as an existing one.
 *
 * The live graph itself (edits, hooks, inference runs) still lives in
 * `lib/live-graph-registry`, keyed by session id at module scope; this
 * store only provides the *data* a pane needs before the engine can start,
 * which is exactly what would otherwise reload per pane.
 */

/** A graph with nothing in it, used before any session ever exists. */
const EMPTY_GRAPH: BlockGraph = { blocks: {}, root: null };

type Snapshot = {
  /** Every session, newest-last-touched first. Kept current in memory by
   *  the mutations below, refreshed wholesale whenever a graph load returns
   *  main's authoritative list. */
  sessions: ChatSessionSummary[];
  hydrated: boolean;
};

const SERVER_SNAPSHOT: Snapshot = { sessions: [], hydrated: false };
let current: Snapshot = { sessions: [], hydrated: false };
const listeners = new Set<() => void>();

/** One `LoadGraphResult` per session id: the seed graph + name. Never
 *  removed on switch; a session's seed is valid for its whole life. */
const seeds = new Map<string, LoadGraphResult>();
/** The in-flight `loadGraph` per session id, so several panes opening the
 *  same session share one IPC round trip. */
const inflight = new Map<string, Promise<LoadGraphResult>>();

function commit(partial: Partial<Snapshot>) {
  current = { ...current, ...partial };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function upsertSessions(sessions: ChatSessionSummary[]) {
  // Main's list is authoritative: a `loadGraph` sweeps and drops emptied
  // sessions and publishes every persisted row, and this store reflects
  // in-memory changes (a first write, a rename, a delete) through its own
  // mutations, so sessions main does not report are not persisted and do
  // not get listed. Replace ours wholesale.
  commit({ sessions: sessions });
}

function loadSessionGraph(sessionId: string): Promise<LoadGraphResult> {
  // Already loaded for another pane? Hand it straight back — no IPC.
  const seeded = seeds.get(sessionId);
  if (seeded) return Promise.resolve(seeded);
  const inFlight = inflight.get(sessionId);
  if (inFlight) return inFlight;
  const task = window.api.chat
    .loadGraph(sessionId)
    .then((result): LoadGraphResult => {
      seeds.set(sessionId, result);
      // The load came back with the full, authoritative sessions list; a
      // `loadGraph` sweep may have dropped emptied sessions, so adopt it.
      upsertSessions(result.sessions);
      inflight.delete(sessionId);
      return result;
    });
  inflight.set(sessionId, task);
  return task;
}

/**
 * The seed graph + name for a session (or the most recent one, when no id
 * is given), loading it over IPC at most once per session. Panes for the
 * same session share the loaded result; a brand-new session created through
 * this store is already seeded by its own create and resolves instantly.
 */
function ensureSessionGraph(sessionId?: string): Promise<LoadGraphResult> {
  if (sessionId) return loadSessionGraph(sessionId);
  const top = current.sessions[0];
  if (top) return loadSessionGraph(top.id);
  return Promise.resolve({
    graph: EMPTY_GRAPH,
    sessions: current.sessions,
    session: null,
  });
}

/** A fresh session, written to main. It is *pending* — main holds only a
 *  name and a minted default graph, and creates the row together with the
 *  first real write (`saveChatGraph`) — so it is seeded here for instant
 *  pane rendering but deliberately NOT listed as a session yet. A quiet
 *  never-edited session must not read as an existing session in the recent
 *  menu; it appears there the first time its first block is saved. */
async function createSession(name: string): Promise<CreateSessionResult> {
  const result = await window.api.chat.createChatSession(name);
  if (result.error || !result.id || !result.graph) return result;
  // Seed the graph from the create result — no follow-up `loadGraph` IPC
  // for this session, ever.
  seeds.set(result.id, {
    graph: result.graph,
    sessions: current.sessions,
    session: { id: result.id, name: result.name ?? name },
  });
  return result;
}

/** Forks a session, then switches to the copy. A copy of a written session
 *  is written to main immediately (a real persisted session — listed); a
 *  copy of a pending, never-written source is itself pending (seeded, not
 *  listed) until its first block is saved, exactly like `createSession`. */
async function duplicateSession(
  sourceId: string,
): Promise<CreateSessionResult> {
  const result = await window.api.chat.duplicateChatSession(sourceId);
  if (result.error || !result.id) return result;
  const name = result.name ?? summaryNameOf(result.id);
  if (result.graph) {
    // Pending source: seed the minted graph like a plain create.
    seeds.set(result.id, {
      graph: result.graph,
      sessions: current.sessions,
      session: { id: result.id, name },
    });
  } else {
    // Already written by main — a real persisted session, list it now.
    upsertSessionSummary({ id: result.id, name, modifiedAt: Date.now() });
  }
  return result;
}

function summaryNameOf(id: string): string {
  return (
    seeds.get(id)?.session?.name ??
    current.sessions.find((s) => s.id === id)?.name ??
    "Untitled"
  );
}

/** Renames in place; the list and the seed's name both follow, so no pane
 *  needs to refetch anything. A pending session is not in the list, but
 *  its seed's name is updated so it persists under the new name at its
 *  first write. */
async function renameSession(
  graphId: string,
  name: string,
): Promise<MutationResult> {
  const result = await window.api.chat.renameChatSession(graphId, name);
  if (result.error) return result;
  const seed = seeds.get(graphId);
  if (seed) seeds.set(graphId, { ...seed, session: { id: graphId, name } });
  commit({
    sessions: current.sessions.map((s) =>
      s.id === graphId ? { ...s, name } : s,
    ),
  });
  return result;
}

/** Deletes outright; drops the session's cached engine too, so a session id
 *  somehow reused later starts clean rather than resuming whatever was last
 *  streaming into this one. */
async function deleteSession(graphId: string): Promise<MutationResult> {
  const result = await window.api.chat.deleteChatSession(graphId);
  if (result.error) return result;
  dropLiveGraph(graphId);
  seeds.delete(graphId);
  commit({ sessions: current.sessions.filter((s) => s.id !== graphId) });
  return result;
}

/** Persists a session's whole live graph (autosave, and the manual `s`
 *  shortcut). Routed through the store so the sessions list tracks what is
 *  actually on disk instead of what a fresh pane merely created in memory:
 *  - a session's first real write creates its row in main, so it enters
 *    the list right there (this is when a pending session "becomes real");
 *  - writing away its last block leaves an empty session, which main drops
 *    (the row only exists while it has blocks), so it leaves the list again
 *    even though the engine still holds the empty graph in memory. */
async function saveSession(
  graphId: string,
  blocks: BlockInput[],
): Promise<MutationResult> {
  const result = await window.api.chat.saveGraph(graphId, blocks);
  if (result.error) return result;
  if (blocks.length === 0) {
    const sessions = current.sessions.filter((s) => s.id !== graphId);
    if (sessions.length !== current.sessions.length) commit({ sessions });
  } else {
    upsertSessionSummary({
      id: graphId,
      name: summaryNameOf(graphId),
      modifiedAt: Date.now(),
    });
  }
  return result;
}

function upsertSessionSummary(entry: ChatSessionSummary) {
  commit({
    sessions: [
      entry,
      ...current.sessions.filter((s) => s.id !== entry.id),
    ].sort((a, b) => b.modifiedAt - a.modifiedAt),
  });
}

type ChatStoreValue = {
  sessions: ChatSessionSummary[];
  hydrated: boolean;
  ensureSessionGraph: (sessionId?: string) => Promise<LoadGraphResult>;
  createChatSession: (name: string) => Promise<CreateSessionResult>;
  duplicateChatSession: (sourceId: string) => Promise<CreateSessionResult>;
  renameChatSession: (graphId: string, name: string) => Promise<MutationResult>;
  deleteChatSession: (graphId: string) => Promise<MutationResult>;
  saveChatGraph: (graphId: string, blocks: BlockInput[]) => Promise<MutationResult>;
};

const context = createContext<ChatStoreValue | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState(SERVER_SNAPSHOT);
  useEffect(() => {
    const unsubscribe = subscribe(() => setSnapshot(current));
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        // One `loadGraph()` with no session returns the full sessions list
        // and seeds the most recent session's graph — exactly what primes
        // the store at boot. Upsert (rather than replace) keeps a
        // brand-new pending session the main process cannot see yet. Every
        // later pane reads this already-loaded data without an IPC.
        const result = await window.api.chat.loadGraph();
        if (result.session?.id) {
          seeds.set(result.session.id, result);
        }
        upsertSessions(result.sessions);
        commit({ hydrated: true });
      } catch {
        // Unreachable main process; keep defaults rather than crash the
        // shell. A pane's ChatPage will keep its plain "loading" state.
        commit({ hydrated: true });
      }
    })();
  }, []);

  const value = useMemo<ChatStoreValue>(
    () => ({
      sessions: snapshot.sessions,
      hydrated: snapshot.hydrated,
      ensureSessionGraph,
      createChatSession: createSession,
      duplicateChatSession: duplicateSession,
      renameChatSession: renameSession,
      deleteChatSession: deleteSession,
      saveChatGraph: saveSession,
    }),
    [snapshot],
  );

  return <context.Provider value={value}>{children}</context.Provider>;
}

/** Reads the shared chat data. Every chat pane mounts against this; panes
 * never touch the sessions IPC themselves. */
export function useChatStore(): ChatStoreValue {
  const value = useContext(context);
  if (!value) throw new Error("useChatStore outside ChatProvider");
  return value;
}
