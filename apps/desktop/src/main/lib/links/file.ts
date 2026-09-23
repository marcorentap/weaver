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
  "release",
  ".git",
  ".turbo",
  ".next",
  "coverage",
]);

/** Stop walking after this many entries (files and directories together). A
 *  project this size cannot be browsed meaningfully anyway, and the bound
 *  keeps a stray `node_modules` from hanging the search. */
const MAX_PATHS = 20_000;

/** How long a walk is reused. Long enough to cover a burst of keystrokes,
 *  short enough that a file created mid-message shows up without a restart. */
const CACHE_TTL_MS = 5_000;

/** How many roots' walks to keep at once. A search's root is the message's
 *  merged `WEAVER_PWD`, so messages under different environments have
 *  different roots; a single slot would have them evict each other and
 *  re-walk the project on every keystroke. A handful of slots covers the
 *  working set, and least-recently-used is the right thing to drop. */
const MAX_ROOTS = 8;

type Cache = { at: number; paths: string[] };

/** Insertion order is recency: a hit is re-inserted, so the first key is
 *  always the one to evict. */
const caches = new Map<string, Cache>();

/** Depth-first, non-recursive walk of `root`, returning project-relative
 *  paths (`./` prefixed) for regular files. A directory is returned with a
 *  trailing slash — it is offered as a prefix to keep typing into, not as a
 *  finished value. Symlinks are skipped so a link back up the tree cannot
 *  loop. */
function walk(root: string): string[] {
  const paths: string[] = [];
  const pending: string[] = [root];
  while (pending.length > 0 && paths.length < MAX_PATHS) {
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
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) {
          continue;
        }
        paths.push(`./${rel}/`);
        pending.push(full);
      } else if (entry.isFile()) {
        paths.push(`./${rel}`);
        if (paths.length >= MAX_PATHS) break;
      }
    }
  }
  // Stable, alphabetical order so the empty-query list is the top of the
  // project rather than whatever order the directory walk happened to use.
  // `./src/` sorts before `./src/App.tsx`, so a directory is listed just
  // above the entries it holds.
  return paths.sort();
}

function fileList(root: string): string[] {
  const hit = caches.get(root);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    caches.delete(root);
    caches.set(root, hit);
    return hit.paths;
  }
  const paths = walk(root);
  caches.delete(root);
  caches.set(root, { at: Date.now(), paths });
  while (caches.size > MAX_ROOTS) {
    const oldest = caches.keys().next().value;
    if (oldest === undefined) break;
    caches.delete(oldest);
  }
  return paths;
}

export const fileProvider: LinkProvider = {
  id: "file",
  label: "file",
  description: "A file or directory in the project.",
  async search(query, { root, limit }): Promise<LinkOption[]> {
    const paths = fileList(root);
    return fuzzyFilter(query, paths, (path) => path, limit).map((value) => ({
      value,
      // A directory keeps the menu open so the next segment can be typed or
      // picked; a file is the whole link and closes it.
      expand: value.endsWith("/"),
    }));
  },
};
