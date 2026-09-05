import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The directory an agent treats as "the project", and the boundary the
 * `weaver-media://` protocol handler will serve files from.
 *
 * It is the nearest ancestor of the process's own cwd that holds a `.git`
 * directory, because the app's cwd is wherever it was launched from —
 * `apps/desktop` during development — and an agent asked to read
 * `apps/desktop/foo` would otherwise resolve it against the app directory
 * and miss. Falls back to the cwd when nothing above it looks like a
 * repository.
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
