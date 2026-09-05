import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSsh, shellQuote, sshPath } from "./ssh.js";

/**
 * Where `write`/`edit` point at: a real filesystem, unlike `read`, which
 * also fetches URLs — writing to an arbitrary `http(s)://` URL has no
 * general meaning, so that scheme is rejected here rather than accepted and
 * silently doing nothing useful.
 */
export type FileTarget =
  | { kind: "local"; path: string }
  | { kind: "ssh"; url: URL };

const SCHEMES = new Set(["file:", "ssh:"]);

/** A whole file's worth, capped — large enough for any real source file,
 *  small enough that hitting it means this is the wrong tool for that
 *  file (a data dump, a binary) rather than a source edit. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Resolves `target` — a bare filesystem path (relative to `cwd`, or
 * absolute), a `file://` URI, or an `ssh://[user@]host[:port]/path` URI —
 * to where `write`/`edit` should act. Throws on anything else, including
 * `http(s)://`.
 */
export function resolveFileTarget(target: string, cwd: string): FileTarget {
  if (!target.includes("://")) {
    return {
      kind: "local",
      path: isAbsolute(target) ? target : resolve(cwd, target),
    };
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`not a valid path or URI: ${target}`);
  }
  if (!SCHEMES.has(url.protocol)) {
    throw new Error(
      `unsupported scheme "${url.protocol}" — pass a filesystem path, file://, or ssh:// URI`,
    );
  }
  return url.protocol === "file:"
    ? { kind: "local", path: fileURLToPath(url) }
    : { kind: "ssh", url };
}

/** The label a diff or an error message shows for `target`. */
export function targetLabel(target: FileTarget): string {
  return target.kind === "local" ? target.path : target.url.toString();
}

/** Reads the whole file at `target`, capped at `MAX_BYTES` — `edit` matches
 *  `oldText` against the real, complete file, so this never silently
 *  truncates; it throws instead, past the cap. */
export async function readWhole(target: FileTarget): Promise<string> {
  if (target.kind === "local") {
    const info = await stat(target.path);
    if (info.size > MAX_BYTES) {
      throw new Error(
        `${target.path} is ${info.size} bytes — too large to edit safely (limit ${MAX_BYTES})`,
      );
    }
    return await readFile(target.path, "utf8");
  }
  const path = shellQuote(sshPath(target.url));
  const buf = await runSsh(target.url, `cat -- ${path}`);
  if (buf.length > MAX_BYTES) {
    throw new Error(
      `${targetLabel(target)} is ${buf.length} bytes — too large to edit safely (limit ${MAX_BYTES})`,
    );
  }
  return buf.toString("utf8");
}

/** Writes (creates or overwrites) `content` at `target`, creating parent
 *  directories as needed. */
export async function writeWhole(
  target: FileTarget,
  content: string,
): Promise<void> {
  if (target.kind === "local") {
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, content, "utf8");
    return;
  }
  const path = shellQuote(sshPath(target.url));
  const command = `mkdir -p -- "$(dirname -- ${path})" && cat > ${path}`;
  await runSsh(target.url, command, Buffer.from(content, "utf8"));
}
