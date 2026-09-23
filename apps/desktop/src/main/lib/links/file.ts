import { readdirSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import { fuzzyFilter } from "../../../shared/fuzzy.js";
import type { LinkOption } from "../../../shared/ipc-contract.js";
import type { LinkProvider } from "./types.js";

/**
 * Directories never worth offering as a `@file:`: build output, VCS metadata
 * and dependency trees would drown every real match. A directory whose name
 * starts with `.` is skipped too, so hidden config stays out unless a user
 * types its path by hand.
 */
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  ".git",
  ".turbo",
  ".next",
  "coverage",
]);

/** Stop walking after this many files. A project this size cannot be
 *  browsed meaningfully anyway, and the bound keeps a stray `node_modules`
 *  from hanging the search. */
const MAX_FILES = 20_000;

/** How long a walk is reused. Long enough to cover a burst of keystrokes,
 *  short enough that a file created mid-message shows up without a restart. */
const CACHE_TTL_MS = 5_000;

type Cache = { root: string; at: number; files: string[] };

let cache: Cache | null = null;

/** Depth-first, non-recursive walk of `root`, returning project-relative
 *  paths (`./` prefixed) for regular files. Symlinks are skipped so a link
 *  back up the tree cannot loop. */
function walk(root: string): string[] {
  const files: string[] = [];
  const pending: string[] = [root];
  while (pending.length > 0 && files.length < MAX_FILES) {
    const dir = pending.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) {
          continue;
        }
        pending.push(full);
      } else if (entry.isFile()) {
        const rel = relative(root, full).split(sep).join("/");
        files.push(`./${rel}`);
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  // Stable, alphabetical order so the empty-query list is the top of the
  // project rather than whatever order the directory walk happened to use.
  return files.sort();
}

function fileList(root: string): string[] {
  if (cache && cache.root === root && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.files;
  }
  const files = walk(root);
  cache = { root, at: Date.now(), files };
  return files;
}

export const fileProvider: LinkProvider = {
  id: "file",
  label: "file",
  description: "A file in the project.",
  async search(query, { root, limit }): Promise<LinkOption[]> {
    const files = fileList(root);
    return fuzzyFilter(query, files, (path) => path, limit).map((value) => ({
      value,
    }));
  },
};
