import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * The directory an agent treats as "the project", and the boundary the
 * `weaver-media://` protocol handler will serve files from.
 *
 * It is the nearest ancestor of the process's own cwd that holds a `.git`
 * directory, because the app's cwd is wherever it was launched from:
 * `apps/desktop` during development. An agent asked to read
 * `apps/desktop/foo` would otherwise resolve it against the app directory
 * and miss the file. Falls back to the cwd when nothing above it looks like
 * a repository.
 */
export function projectRoot(): string {
  let at = resolve(process.cwd());
  for (;;) {
    if (existsSync(`${at}/.git`)) return at;
    const up = dirname(at);
    if (up === at) return resolve(process.cwd());
    at = up;
  }
}

/**
 * The directory a consumer treats as "the project" for a block: its merged
 * `WEAVER_PWD` when one applies, resolved against the project root for a
 * relative value — the same rule an inference run uses for its working
 * directory — or the project root itself when the block sets none. An
 * `@file:` link search walks this base, so the "current project" follows the
 * graph's environment as a run anchored in the same place would.
 */
export function weaverRoot(pwd?: string): string {
  const base = projectRoot();
  if (!pwd) return base;
  return isAbsolute(pwd) ? pwd : resolve(base, pwd);
}
