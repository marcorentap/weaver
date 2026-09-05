import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSsh, shellQuote, sshPath } from "./ssh";

/** Schemes this reads directly; anything else is a bare filesystem path. */
const SCHEMES = new Set(["file:", "http:", "https:", "ssh:"]);

/** Default read cap, and the ceiling an explicit `byteLength` is clamped
 *  to — plenty for a tool result, not enough to flood the model with a
 *  whole log file. */
const MAX_BYTES = 256 * 1024;

function parseSource(source: string): URL | null {
  // A bare filesystem path is legal input and is not a URI, so this only
  // treats `source` as one when it actually looks like one — otherwise
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

/** Reads exactly `[start, start + length)`, or fewer bytes at real EOF —
 *  never more, so a caller can tell "hit the end of the file" apart from
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

async function readHttpRange(url: URL, start: number, length: number): Promise<Buffer> {
  const to = start + length - 1;
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${to}` } });
  if (!res.ok && res.status !== 206) {
    throw new Error(`${url} responded ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // A server that ignores `Range` sends the whole body from byte 0 with a
  // plain 200; slice locally rather than trust the header was honoured. A
  // huge such resource is still downloaded whole either way — a pre-existing
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
   *  unit — a single huge line, e.g. minified JS or one long JSON blob —
   *  needs this and `byteLength` instead of `offset`/`limit`. Mutually
   *  exclusive with `offset`/`limit`. */
  byteOffset?: number;
  /** Max bytes to read starting at `byteOffset`; clamped to `MAX_BYTES`. */
  byteLength?: number;
};

export type ReadSourceResult = {
  content: string;
  /** Whether there is more content past what `content` holds — past
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

/**
 * Reads `source` — a bare filesystem path, or a `file://`, `http(s)://` or
 * `ssh://` URI — windowed either by line (`offset`/`limit`, the default) or
 * by byte (`byteOffset`/`byteLength`, for content a line boundary can't
 * usefully cut). `cwd` anchors a bare relative path; every URI form is
 * self-contained.
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

  const buf = await fetchRange(backend, 0, MAX_BYTES);
  const lines = buf.toString("utf8").split("\n");
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
