import "server-only";
import type { Store } from "@repo/store";
import { newId, openStore } from "@repo/store";
import { kinds } from "@/blocks/kinds";
import { seedBlocks } from "@/lib/seed";

// Turbopack re-evaluates modules on HMR, so the handle is cached on globalThis
// to avoid leaking a SQLite connection per edit during development.
//
// The cache is keyed by a per-evaluation nonce, because the store closes over
// the kind registry it validates writes against: a handle kept across a reload
// would keep validating against the kinds of a previous module instance, which
// silently lets unvalidated state reach the database.
const nonce = newId();

// The cached value may predate this module's shape, so nothing about it is
// assumed beyond "it might be closeable".
const cache = globalThis as unknown as {
  weaverStore?: { store?: Store; nonce?: string };
};

/** Name of the session a fresh store starts with. */
const SEED_GRAPH = "dev";

/**
 * An empty database has no session for chat to open, and `/api/media` serves
 * only URIs a block references — so seeding is what makes a first run show
 * anything at all.
 */
function seeded(store: Store): Store {
  if (store.listGraphs().length === 0) {
    const record = store.createGraph(SEED_GRAPH);
    store.writeGraph(record.id, seedBlocks());
  }
  return store;
}

export function getStore(): Store {
  const cached = cache.weaverStore;
  if (cached && cached.nonce !== nonce) {
    try {
      cached.store?.close();
    } catch {
      // Already closed, or a handle from an incompatible earlier shape. Either
      // way it is being dropped; a failed close must not break the request.
    }
    cache.weaverStore = undefined;
  }
  // Passing the registry validates block state against its schema on write.
  cache.weaverStore ??= { store: seeded(openStore({ kinds })), nonce };
  return cache.weaverStore.store as Store;
}
