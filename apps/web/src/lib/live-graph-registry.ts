import type { BlockGraph } from "@repo/core";
import { createLiveGraph, type LiveGraph } from "./live-graph";

/**
 * Engines keyed by graph (session) id, held at module scope — like
 * `lib/settings`'s store, entirely outside React. `ChatView` used to own its
 * engine in `useState`, which Next.js tears down along with the rest of the
 * page whenever the route changes, including a plain tab switch away from
 * `/chat` and back: an inference run streaming into that engine got silently
 * orphaned, and the page that remounted started over from whatever was last
 * saved. Caching the engine here instead means the same instance — and
 * whatever run is still streaming into it — is simply reattached to on
 * remount.
 */
const engines = new Map<string, LiveGraph>();

/**
 * The live engine for `graphId`, created from `initial` the first time it is
 * asked for and reused after that. `initial` is only a seed: once an engine
 * exists for this id, its own state is more current than whatever a fresh
 * server render loaded, so later calls ignore the argument entirely.
 */
export function getLiveGraph(graphId: string, initial: BlockGraph): LiveGraph {
  const existing = engines.get(graphId);
  if (existing) return existing;
  const created = createLiveGraph(initial);
  engines.set(graphId, created);
  return created;
}

/** Drops a deleted session's engine, so a future id — never reused in
 *  practice, since ids are UUIDs, but cheap insurance regardless — starts
 *  clean rather than resuming whatever was last streaming into this one. */
export function dropLiveGraph(graphId: string): void {
  engines.delete(graphId);
}
