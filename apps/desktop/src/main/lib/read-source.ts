import { open, readdir, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSsh, shellQuote, sshPath } from "./ssh.js";
import { MAX_READ_BYTES, buildSymbolIndex } from "./symbol-index.js";

/** Schemes this reads directly; anything else is a bare filesystem path. */
const SCHEMES = new Set(["file:", "http:", "https:", "ssh:"]);

/**
 * Read budget: the ceiling an explicit `byteLength` is clamped to, the page
 * size a line window is scanned in, and what a whole-file content read of a
 * non-code file returns. A read result never exceeds this, so the worst
 * case one tool call injects into context is about 1k tokens.
 */
const MAX_BYTES = MAX_READ_BYTES;

/** Internal cap on how far a line-window scan pages forward. Only the
 *  window's own lines are returned (still within `MAX_BYTES`); this bounds
 *  how much IO a window deep in a large file costs. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

function parseSource(source: string): URL | null {
  // A bare filesystem path is legal input and is not a URI, so this only
  // treats `source` as one when it actually looks like one. Otherwise
  // `new URL` on a relative path like "src/foo.ts" throws or, worse, on an
  // absolute one like "/etc/hosts" silently resolves against `file://`.
  if (!source.includes("://")) return null;
  try {
    const url = new URL(source);
    return SCHEMES.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

type Backend =
  | { kind: "local"; path: string }
  | { kind: "http"; url: URL }
  | { kind: "ssh"; url: URL };

function resolveBackend(source: string, cwd: string): Backend {
  const url = parseSource(source);
  if (!url) {
    return { kind: "local", path: isAbsolute(source) ? source : resolve(cwd, source) };
  }
  if (url.protocol === "file:") return { kind: "local", path: fileURLToPath(url) };
  if (url.protocol === "ssh:") return { kind: "ssh", url };
  return { kind: "http", url };
}

/** Reads exactly `[start, start + length)`, or fewer bytes at real EOF.
 *  Never more, so a caller can tell "hit the end of the file" apart from
 *  "there is more after what I asked for" just by comparing lengths. */
async function readLocalRange(path: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** False on any stat failure (missing path, no permission), so a bad path
 *  falls through to the normal file read and fails there with the real
 *  error instead of a misleading "not a directory" here. */
async function isLocalDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** One entry per line, name only, a trailing `/` marking a subdirectory.
 *  Sorted so the result is stable across runs on the same directory. */
async function readLocalDirectory(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function readHttpRange(url: URL, start: number, length: number): Promise<Buffer> {
  const to = start + length - 1;
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${to}` } });
  if (!res.ok && res.status !== 206) {
    throw new Error(`${url} responded ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // A server that ignores `Range` sends the whole body from byte 0 with a
  // plain 200; slice locally rather than trust the header was honoured. A
  // huge such resource is still downloaded whole either way. A pre-existing
  // limitation of reading arbitrary URLs, not one this adds.
  return res.status === 206 ? buf : buf.subarray(start, start + length);
}

/** `tail -c +N | head -c L` bounds the remote side to the range asked for,
 *  rather than streaming a whole huge file down the pipe and truncating on
 *  this end. */
async function readSshRange(url: URL, start: number, length: number): Promise<Buffer> {
  const path = shellQuote(sshPath(url));
  const command =
    start > 0
      ? `tail -c +${start + 1} -- ${path} | head -c ${length}`
      : `head -c ${length} -- ${path}`;
  return runSsh(url, command);
}

/** False whenever the remote `test -d` fails to run at all (bad host,
 *  missing path, no permission), so those fall through to the normal file
 *  read and fail there with the real error instead of a misleading "not a
 *  directory" here. */
async function isSshDirectory(url: URL): Promise<boolean> {
  const path = shellQuote(sshPath(url));
  try {
    const out = await runSsh(url, `[ -d ${path} ] && echo 1 || echo 0`);
    return out.toString("utf8").trim() === "1";
  } catch {
    return false;
  }
}

/** Same shape as `readLocalDirectory`: one sorted entry per line, a
 *  trailing `/` marking a subdirectory. `-p` is `ls`'s own way to mark
 *  that, so sorting is the only local work left. */
async function readSshDirectory(url: URL): Promise<string[]> {
  const path = shellQuote(sshPath(url));
  const out = await runSsh(url, `ls -1p -- ${path}`);
  return out
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

async function fetchRange(backend: Backend, start: number, length: number): Promise<Buffer> {
  switch (backend.kind) {
    case "local":
      return readLocalRange(backend.path, start, length);
    case "ssh":
      return readSshRange(backend.url, start, length);
    case "http":
      return readHttpRange(backend.url, start, length);
  }
}

export type ReadRange = {
  /** 1-indexed line to start at. */
  offset?: number;
  /** Max lines to read. */
  limit?: number;
  /** 0-indexed byte to start at. Content where lines are not a useful
   *  unit, such as a single huge line of minified JS or one long JSON
   *  blob, needs this and `byteLength` instead of `offset`/`limit`.
   *  Mutually exclusive with `offset`/`limit`. */
  byteOffset?: number;
  /** Max bytes to read starting at `byteOffset`; clamped to `MAX_BYTES`. */
  byteLength?: number;
};

export type ReadSourceResult = {
  content: string;
  /** Whether there is more content past what `content` holds: past
   *  `endLine`/`totalLines` in line mode, past `byteEnd` in byte mode. */
  truncated: boolean;
  /** Set in line mode (the default): `offset`/`limit` windowed onto lines
   *  found within the first `MAX_BYTES` of the source. */
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  /** Set in byte mode: the half-open `[byteStart, byteEnd)` actually read. */
  byteStart?: number;
  byteEnd?: number;
};

/** `offset`/`limit` windowed onto `lines`, shared by file content and
 *  directory listings alike: a listing is just lines with no bytes behind
 *  them. */
function windowLines(
  lines: string[],
  offset: number | undefined,
  limit: number | undefined,
): ReadSourceResult {
  const startLine = Math.max(offset ?? 1, 1);
  const endLine =
    limit !== undefined
      ? Math.min(startLine - 1 + limit, lines.length)
      : lines.length;
  const windowed = lines.slice(startLine - 1, endLine);
  return {
    content: windowed.join("\n"),
    truncated: startLine > 1 || endLine < lines.length,
    startLine,
    endLine,
    totalLines: lines.length,
  };
}

/**
 * Reads `source`: a bare filesystem path, or a `file://`, `http(s)://` or
 * `ssh://` URI. A local path, `file://` URI, or `ssh://` URI naming a
 * directory lists its immediate entries instead, one per line, sorted,
 * subdirectories marked with a trailing `/`; `http(s)://` sources are read
 * as files only. A whole-file read (no window) of a local code file returns
 * a tree-sitter symbol index with line numbers; any other whole-file read
 * is bounded to the first `MAX_BYTES`. Windowed reads return the requested
 * lines or bytes, still bounded by `MAX_BYTES`, and never a whole file.
 * `cwd` anchors a bare relative path; every URI form is self-contained.
 */
export async function readSource(
  source: string,
  cwd: string,
  range: ReadRange = {},
): Promise<ReadSourceResult> {
  const { offset, limit, byteOffset, byteLength } = range;
  const byteMode = byteOffset !== undefined || byteLength !== undefined;
  if (byteMode && (offset !== undefined || limit !== undefined)) {
    throw new Error(
      "pass either offset/limit (lines) or byteOffset/byteLength (bytes), not both",
    );
  }

  const backend = resolveBackend(source, cwd);

  let directoryLines: string[] | null = null;
  if (backend.kind === "local") {
    if (await isLocalDirectory(backend.path)) {
      directoryLines = await readLocalDirectory(backend.path);
    }
  } else if (backend.kind === "ssh") {
    if (await isSshDirectory(backend.url)) {
      directoryLines = await readSshDirectory(backend.url);
    }
  }
  if (directoryLines !== null) {
    if (byteMode) {
      throw new Error("byteOffset/byteLength read a file; this path is a directory");
    }
    return windowLines(directoryLines, offset, limit);
  }

  if (byteMode) {
    const start = Math.max(byteOffset ?? 0, 0);
    const requested = Math.min(byteLength ?? MAX_BYTES, MAX_BYTES);
    // One extra byte, never returned, so "did we get more than asked for"
    // answers "is there more past this range" without a second round trip.
    const buf = await fetchRange(backend, start, requested + 1);
    const slice = buf.subarray(0, requested);
    return {
      content: slice.toString("utf8"),
      truncated: buf.length > requested,
      byteStart: start,
      byteEnd: start + slice.length,
    };
  }

  // Whole-file read. A local code file yields a tree-sitter symbol index
  // (see symbol-index.ts) instead of content, and any other whole-file read
  // is bounded to the first page, so no read ever returns a whole file.
  if (offset === undefined && limit === undefined) {
    if (backend.kind === "local") {
      const index = await buildSymbolIndex(backend.path);
      if (index) {
        return { content: index.content, truncated: false, totalLines: index.totalLines };
      }
    }
    const firstPage = await scanText(backend, null);
    const result = windowLines(firstPage.text.split("\n"), undefined, undefined);
    if (!firstPage.eof) {
      result.truncated = true;
      result.totalLines = undefined;
    }
    return result;
  }

  // Windowed read: scan forward until the window is covered, then slice.
  // `totalLines` is only known once the scan reaches EOF (small files,
  // windows near the end); a scan stopped at the IO cap reports no total.
  const until = limit === undefined ? Number.MAX_SAFE_INTEGER : (offset ?? 1) - 1 + limit;
  const scanned = await scanText(backend, until);
  const result = windowLines(scanned.text.split("\n"), offset, limit);
  if (!scanned.eof) {
    result.truncated = true;
    result.totalLines = undefined;
  }
  return result;
}

/**
 * Pages through a source until `until` newlines have passed (or EOF, or the
 * internal `MAX_SCAN_BYTES` cap), so a line window deep in a large file can
 * be served without shipping the whole file's content to the caller. `until
 * === null` returns the first page only, the whole-file bounded read. Local
 * files page in `MAX_BYTES` chunks (cheap seeks); remote ones use one larger
 * chunk per page so a deep window costs a bounded number of round trips.
 * `eof` reports whether the end of the source was reached, which is what
 * lets the caller say "there is more" past a capped scan.
 */
async function scanText(
  backend: Backend,
  until: number | null,
): Promise<{ text: string; eof: boolean }> {
  const chunks: Buffer[] = [];
  let pos = 0;
  let newlines = 0;
  const pageSize = until === null || backend.kind === "local" ? MAX_BYTES : 256 * 1024;
  while (true) {
    const remaining = MAX_SCAN_BYTES - pos;
    if (remaining <= 0) break;
    const length = Math.min(pageSize, remaining);
    const buf = await fetchRange(backend, pos, length);
    chunks.push(buf);
    if (buf.length < length) {
      return { text: Buffer.concat(chunks).toString("utf8"), eof: true };
    }
    if (until === null) break;
    for (const byte of buf) {
      if (byte === 10) newlines++;
    }
    if (newlines >= until) break;
    pos += buf.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), eof: false };
}
