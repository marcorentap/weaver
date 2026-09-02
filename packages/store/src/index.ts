import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  Block,
  BlockData,
  BlockGraph,
  BlockId,
  KindRegistry,
} from "@repo/core";
import { assertTree, assertValidData, rootOf } from "@repo/core";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

/** Rows come off disk, so they are validated rather than trusted. */
const blockRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  created_at: z.number().int(),
  modified_at: z.number().int(),
  next_id: z.string().nullable(),
  children_id: z.string().nullable(),
  data: z.string(),
});

const graphRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.number().int(),
  modified_at: z.number().int(),
});

const idRowSchema = z.object({ id: z.string() });
const blockDataSchema = z.record(z.string(), z.unknown());

export function defaultStorePath(): string {
  return process.env.WEAVER_STORE ?? join(homedir(), ".weaver", "store.db");
}

/**
 * Node exposes no UUIDv7, so ids are v4 and carry no time information.
 * Ordering comes from the blocks' own links instead.
 */
export function newId(): string {
  return randomUUID();
}

/** One graph: an independent block tree, addressed by name. */
export type GraphRecord = {
  id: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
};

/**
 * A block as callers supply it; `modifiedAt` and `revision` belong to the
 * store. Both links default to null — a lone block links to nothing. A
 * `Block` already satisfies this, so a caller holding a graph writes
 * `Object.values(graph.blocks)` rather than re-mapping every field.
 */
export type BlockInput = {
  id: BlockId;
  kind: string;
  label: string;
  createdAt: number;
  next?: BlockId | null;
  children?: BlockId | null;
  data?: BlockData;
};

export type Store = {
  listGraphs: () => GraphRecord[];
  findGraph: (name: string) => GraphRecord | undefined;
  createGraph: (name: string) => GraphRecord;
  deleteGraph: (id: string) => void;
  loadGraph: (graphId: string) => BlockGraph;
  /**
   * Replace a graph's blocks with exactly `inputs`: rows absent from it are
   * deleted. A tree is only ever valid as a whole — an insert rewrites its
   * new neighbor's link, a delete rewrites its predecessor's — so callers
   * apply core's tree operations to a loaded graph and write the result back,
   * rather than trying to express structural edits row by row.
   */
  writeGraph: (graphId: string, inputs: BlockInput[]) => void;
  close: () => void;
};

export type StoreOptions = {
  path?: string;
  /**
   * Kinds to validate block state against on write. Supplying them keeps
   * malformed state out of the database entirely; omitting them means data
   * is only checked when something reads it.
   */
  kinds?: KindRegistry;
};

export function openStore(options: StoreOptions = {}): Store {
  const path = options.path ?? defaultStorePath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  // Foreign keys are OFF by default in SQLite; the cascades depend on them.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  const version = z
    .object({ user_version: z.number().int() })
    .parse(db.prepare("PRAGMA user_version").get()).user_version;
  if (version === 0) {
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } else if (version !== SCHEMA_VERSION) {
    throw new Error(
      `store at ${path} has schema version ${version}, expected ${SCHEMA_VERSION}`,
    );
  }

  const selectGraphs = db.prepare(
    "SELECT id, name, created_at, modified_at FROM graph ORDER BY created_at",
  );
  const selectGraphByName = db.prepare(
    "SELECT id, name, created_at, modified_at FROM graph WHERE name = ?",
  );
  const insertGraph = db.prepare(
    "INSERT INTO graph (id, name, created_at, modified_at) VALUES (?, ?, ?, ?)",
  );
  const touchGraph = db.prepare("UPDATE graph SET modified_at = ? WHERE id = ?");
  const deleteGraphStmt = db.prepare("DELETE FROM graph WHERE id = ?");

  const selectBlocks = db.prepare(`
    SELECT id, kind, label, created_at, modified_at, next_id, children_id, data
    FROM block WHERE graph_id = ?
  `);
  const selectBlockIds = db.prepare("SELECT id FROM block WHERE graph_id = ?");
  const upsertBlock = db.prepare(`
    INSERT INTO block
      (id, graph_id, kind, label, created_at, modified_at, next_id, children_id, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      label = excluded.label,
      created_at = excluded.created_at,
      modified_at = excluded.modified_at,
      next_id = excluded.next_id,
      children_id = excluded.children_id,
      data = excluded.data,
      revision = block.revision + 1
  `);
  const deleteBlockStmt = db.prepare("DELETE FROM block WHERE id = ?");

  const loadGraph = (graphId: string): BlockGraph => {
    const blocks: Record<BlockId, Block> = {};
    for (const raw of selectBlocks.all(graphId)) {
      const row = blockRowSchema.parse(raw);
      blocks[row.id] = {
        id: row.id,
        kind: row.kind,
        label: row.label,
        createdAt: row.created_at,
        modifiedAt: row.modified_at,
        next: row.next_id,
        children: row.children_id,
        data: blockDataSchema.parse(JSON.parse(row.data)),
      };
    }
    return { blocks, root: rootOf(blocks) };
  };

  /**
   * Writes run inside one transaction, validated before commit against the
   * tree invariants and each kind's state schema. SQLite can express neither.
   */
  const transact = (graphId: string, write: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      write();
      const graph = loadGraph(graphId);
      assertTree(graph);
      if (options.kinds) assertValidData(graph, options.kinds);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const toRecord = (raw: unknown): GraphRecord => {
    const row = graphRowSchema.parse(raw);
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      modifiedAt: row.modified_at,
    };
  };

  return {
    listGraphs: () => selectGraphs.all().map(toRecord),

    findGraph: (name) => {
      const raw = selectGraphByName.get(name);
      return raw === undefined ? undefined : toRecord(raw);
    },

    createGraph: (name) => {
      const now = Date.now();
      const id = newId();
      insertGraph.run(id, name, now, now);
      return { id, name, createdAt: now, modifiedAt: now };
    },

    deleteGraph: (id) => void deleteGraphStmt.run(id),

    loadGraph,

    writeGraph: (graphId, inputs) =>
      transact(graphId, () => {
        const now = Date.now();
        const kept = new Set(inputs.map((input) => input.id));
        // Stale rows go first: a block removed from the tree must not still
        // be sitting there, unreachable, when the write is validated.
        for (const raw of selectBlockIds.all(graphId)) {
          const { id } = idRowSchema.parse(raw);
          if (!kept.has(id)) deleteBlockStmt.run(id);
        }
        for (const input of inputs) {
          upsertBlock.run(
            input.id,
            graphId,
            input.kind,
            input.label,
            input.createdAt,
            now,
            input.next ?? null,
            input.children ?? null,
            JSON.stringify(input.data ?? {}),
          );
        }
        touchGraph.run(now, graphId);
      }),

    close: () => db.close(),
  };
}
