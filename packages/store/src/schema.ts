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
 *   database must accept a kind it has never seen.
 * - `block.hidden` is a display/context flag, not part of a kind's state: a
 *   hidden block stays in the graph (so it can be shown again) but is left
 *   out of what the renderer shows and what gets serialized to the agent.
 *   Version 6 added the column via ALTER TABLE; rows from before read as
 *   visible.
* - Structure is two nullable self-references per block: `next_id` is the
 *   following block at the same level, `children_id` the first block nested
 *   inside it. Order is therefore stored, not derived, and one row change
 *   moves a block. The tree invariants, one root, no loops, nothing
 *   orphaned, are not expressible in SQL, so writes are validated in JS
 *   against `assertTree` before commit.
 * - Neither link is a foreign key. A write arrives as a set of rows whose
 *   links point at each other, and immediate FK checks would reject
 *   whichever row happened to land first.
 */
export const SCHEMA_VERSION = 6;

export const SCHEMA_SQL = `
CREATE TABLE graph (
  id          TEXT PRIMARY KEY,
  -- Not unique: a session is identified by id, and its name is
  -- display-only, so two sessions may share one.
  name        TEXT NOT NULL,
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
  next_id     TEXT,
  children_id TEXT,
  data        TEXT NOT NULL DEFAULT '{}',
  hidden      INTEGER NOT NULL DEFAULT 0,
  revision    INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX block_graph ON block(graph_id, created_at);

-- Opaque renderer preferences (appearance, AI provider settings): one row
-- per key, value is whatever JSON string the caller gave it. The store
-- validates nothing about the value's shape; that's the renderer's concern.
CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;
