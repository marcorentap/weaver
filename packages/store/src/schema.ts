/**
 * Schema for the block store.
 *
 * Deliberate choices:
 *
 * - Blocks belong to a `graph`, so the store holds many independent graphs the
 *   way a chat app holds many conversations.
 * - Ids are `crypto.randomUUID()` (v4). Node has no UUIDv7, so ordering
 *   information lives in `created_at` / `modified_at` rather than in the id.
 * - `block.kind` has no CHECK constraint. Kinds are open by design, so the
 *   database must accept a kind it has never seen. `block_edge.relation` does
 *   get a CHECK, because that set is structural and closed.
 * - No ordering column anywhere. Sibling order is derived from topological
 *   order with `created_at` as the tiebreaker, so there is nothing to drift.
 */
export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE graph (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
) STRICT;

CREATE TABLE block (
  id          TEXT PRIMARY KEY,
  graph_id    TEXT NOT NULL REFERENCES graph(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  label       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  revision    INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE block_edge (
  parent_id TEXT NOT NULL REFERENCES block(id) ON DELETE CASCADE,
  child_id  TEXT NOT NULL REFERENCES block(id) ON DELETE CASCADE,
  relation  TEXT NOT NULL CHECK (relation IN ('depends','contains')),
  PRIMARY KEY (parent_id, child_id, relation)
) STRICT;

CREATE INDEX block_edge_child ON block_edge(child_id, relation);
CREATE INDEX block_graph ON block(graph_id, created_at);
`;
