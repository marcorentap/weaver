import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { BlockGraph } from "@repo/core";
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
  // The main process's list is authoritative for sessions it knows, but it
  // cannot see brand-new pending sessions (their row does not exist until
  // the first write), so merge: keep anything we have that main did not
  // report, sorted newest-first alongside the authoritative entries.
  const merged = [...sessions];
  for (const entry of current.sessions) {
    if (!merged.some((s) => s.id === entry.id)) merged.push(entry);
  }
  merged.sort((a, b) => b.modifiedAt - a.modifiedAt);
  commit({ sessions: merged });
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

/** A fresh session, written to main; seeds its graph so the pane aimed at
 *  it renders immediately. */
async function createSession(name: string): Promise<CreateSessionResult> {
  const result = await window.api.chat.createChatSession(name);
  if (result.error || !result.id || !result.graph) return result;
  // Seed the graph from the create result — no follow-up `loadGraph` IPC
  // for this session, ever.
  seeds.set(result.id, {
    graph: result.graph,
    sessions: current.sessions,
    session: { id: result.id, name },
  });
  upsertSessionSummary({ id: result.id, name, modifiedAt: Date.now() });
  return result;
}

/** Forks a session; the copy shows up in the list right away, its graph is
 *  loaded (singleflight) the first time a pane opens it. */
async function duplicateSession(
  sourceId: string,
): Promise<CreateSessionResult> {
  const result = await window.api.chat.duplicateChatSession(sourceId);
  if (result.error || !result.id) return result;
  if (result.graph) {
    // An empty source duplicates into a fresh pending session whose graph
    // main already minted — seed it like a plain create.
    seeds.set(result.id, {
      graph: result.graph,
      sessions: current.sessions,
      session: { id: result.id, name: summaryNameOf(result.id) },
    });
  }
  upsertSessionSummary({
    id: result.id,
    name: summaryNameOf(result.id),
    modifiedAt: Date.now(),
  });
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
 *  needs to refetch anything. */
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
