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
import { assertAcyclic, assertValidData } from "@repo/core";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

/** Rows come off disk, so they are validated rather than trusted. */
const blockRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  created_at: z.number().int(),
  modified_at: z.number().int(),
  data: z.string(),
});

const edgeRowSchema = z.object({
  parent_id: z.string(),
  child_id: z.string(),
  relation: z.enum(["depends", "contains"]),
});

const graphRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.number().int(),
  modified_at: z.number().int(),
});

const blockDataSchema = z.record(z.string(), z.unknown());
const countSchema = z.object({ n: z.number().int() });

export function defaultStorePath(): string {
  return process.env.WEAVER_STORE ?? join(homedir(), ".weaver", "store.db");
}

/**
 * Node exposes no UUIDv7, so ids are v4 and carry no time information.
 * Ordering comes from `createdAt` / `modifiedAt` instead.
 */
export function newId(): string {
  return randomUUID();
}

/** One graph: an independent block DAG, addressed by name. */
export type GraphRecord = {
  id: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
};

/** A block as callers supply it; `modifiedAt` and `revision` belong to the store. */
export type BlockInput = {
  id: BlockId;
  kind: string;
  label: string;
  createdAt: number;
  parents?: BlockId[];
  children?: BlockId[];
  data?: BlockData;
};

export type Store = {
  listGraphs: () => GraphRecord[];
  findGraph: (name: string) => GraphRecord | undefined;
  createGraph: (name: string) => GraphRecord;
  deleteGraph: (id: string) => void;
  loadGraph: (graphId: string) => BlockGraph;
  countBlocks: (graphId: string) => number;
  putBlocks: (graphId: string, inputs: BlockInput[]) => void;
  deleteBlock: (id: BlockId) => void;
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

  const selectBlocks = db.prepare(
    "SELECT id, kind, label, created_at, modified_at, data FROM block WHERE graph_id = ?",
  );
  const selectEdges = db.prepare(`
    SELECT e.parent_id, e.child_id, e.relation
    FROM block_edge e
    JOIN block p ON p.id = e.parent_id
    WHERE p.graph_id = ?
  `);
  const upsertBlock = db.prepare(`
    INSERT INTO block (id, graph_id, kind, label, created_at, modified_at, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      label = excluded.label,
      created_at = excluded.created_at,
      modified_at = excluded.modified_at,
      data = excluded.data,
      revision = block.revision + 1
  `);
  const clearParents = db.prepare(
    "DELETE FROM block_edge WHERE child_id = ? AND relation = 'depends'",
  );
  const clearChildren = db.prepare(
    "DELETE FROM block_edge WHERE parent_id = ? AND relation = 'contains'",
  );
  const insertEdge = db.prepare(
    "INSERT OR IGNORE INTO block_edge (parent_id, child_id, relation) VALUES (?, ?, ?)",
  );
  const deleteBlockStmt = db.prepare("DELETE FROM block WHERE id = ?");
  const countBlocksStmt = db.prepare(
    "SELECT count(*) AS n FROM block WHERE graph_id = ?",
  );
  // Edges are meaningless across graphs; nothing in SQL forbids them.
  const countCrossGraphEdges = db.prepare(`
    SELECT count(*) AS n
    FROM block_edge e
    JOIN block p ON p.id = e.parent_id
    JOIN block c ON c.id = e.child_id
    WHERE p.graph_id <> c.graph_id
  `);

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
        parents: [],
        children: [],
        data: blockDataSchema.parse(JSON.parse(row.data)),
      };
    }
    for (const raw of selectEdges.all(graphId)) {
      const edge = edgeRowSchema.parse(raw);
      const parent = blocks[edge.parent_id];
      const child = blocks[edge.child_id];
      if (!parent || !child) continue;
      if (edge.relation === "depends") child.parents.push(edge.parent_id);
      else parent.children.push(edge.child_id);
    }
    return { blocks };
  };

  /**
   * Writes run inside one transaction, validated before commit against core's
   * cycle check, each kind's state schema, and graph containment. SQLite can
   * express none of the three.
   */
  const transact = (graphId: string, write: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      write();
      const graph = loadGraph(graphId);
      assertAcyclic(graph);
      if (options.kinds) assertValidData(graph, options.kinds);
      if (countSchema.parse(countCrossGraphEdges.get()).n > 0) {
        throw new Error("block edge spans two graphs");
      }
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

    countBlocks: (graphId) =>
      countSchema.parse(countBlocksStmt.get(graphId)).n,

    putBlocks: (graphId, inputs) =>
      transact(graphId, () => {
        const now = Date.now();
        for (const input of inputs) {
          upsertBlock.run(
            input.id,
            graphId,
            input.kind,
            input.label,
            input.createdAt,
            now,
            JSON.stringify(input.data ?? {}),
          );
        }
        // Edges are replaced wholesale so each row mirrors its input exactly.
        for (const input of inputs) {
          clearParents.run(input.id);
          clearChildren.run(input.id);
          for (const parent of input.parents ?? []) {
            insertEdge.run(parent, input.id, "depends");
          }
          for (const child of input.children ?? []) {
            insertEdge.run(input.id, child, "contains");
          }
        }
        touchGraph.run(now, graphId);
      }),

    deleteBlock: (id) => void deleteBlockStmt.run(id),

    close: () => db.close(),
  };
}
