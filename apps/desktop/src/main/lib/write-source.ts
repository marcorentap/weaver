import { resolveFileTarget, writeWhole } from "./file-target.js";

/**
 * Writes (creates or overwrites) `content` at `target` — a bare filesystem
 * path, a `file://` URI, or an `ssh://[user@]host[:port]/path` URI. Parent
 * directories are created as needed, same as the built-in `write` tool this
 * replaces. `cwd` anchors a bare relative path.
 */
export async function writeSource(
  target: string,
  cwd: string,
  content: string,
): Promise<void> {
  await writeWhole(resolveFileTarget(target, cwd), content);
}
