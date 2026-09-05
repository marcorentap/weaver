import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { protocol, type CustomScheme } from "electron";
import { MEDIA_KIND, mediaInfo, parseMediaUri } from "../../shared/blocks/media.js";
import { MEDIA_PROTOCOL } from "../../shared/ipc-contract.js";
import { projectRoot } from "../lib/project.js";
import { getStore } from "../lib/store.js";
import { isPendingMedia } from "../lib/pending-media.js";

/**
 * Privileges the `weaver-media://` scheme needs registered before
 * `app.whenReady()`. `standard`/`secure` let `<img>`/`<video>`/`<audio>`
 * treat it like `https:`; `stream` lets a ranged local file be served as
 * it's read rather than buffered whole; `supportFetchAPI`/`corsEnabled`
 * let a plain `fetch()` in the renderer read remote text through it too.
 */
export const MEDIA_PROTOCOL_PRIVILEGES: CustomScheme = {
  scheme: MEDIA_PROTOCOL,
  privileges: {
    standard: true,
    secure: true,
    stream: true,
    supportFetchAPI: true,
    corsEnabled: true,
    bypassCSP: false,
    codeCache: false,
  },
};

/**
 * Serves media the renderer cannot fetch itself. `file://` bytes a renderer
 * page may not read, and remote text `fetch` may not read without CORS
 * headers on the origin.
 *
 * What may be served is either something a media block already points at, a
 * file inside the project directory, or a URI the display tool has just
 * handed to a live agent run (see `pending-media.ts`). The second and third
 * rules exist because an agent's output is live. It displays a file it just
 * read or wrote, and the block showing it is only in the renderer until the
 * next autosave, so a store-reference check alone would blank every fresh
 * block for a few seconds. The first and third rules only let through a
 * URI a block or run already points at.
 */
function isReferenced(uri: string): boolean {
  const store = getStore();
  for (const record of store.listGraphs()) {
    for (const block of Object.values(store.loadGraph(record.id).blocks)) {
      if (block.kind === MEDIA_KIND && block.data.uri === uri) return true;
    }
  }
  return false;
}

/** Whether `path` is inside the project this app was started in. */
function inProject(path: string): boolean {
  const root = projectRoot();
  const target = resolve(path);
  return target === root || target.startsWith(`${root}/`);
}

/** Parses `bytes=start-end`, the only range form browsers send for media. */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return null;

  // A suffix range ("bytes=-500") counts back from the end of the file.
  const start = rawStart === "" ? size - Number(rawEnd) : Number(rawStart);
  const end = rawStart === "" || rawEnd === "" ? size - 1 : Number(rawEnd);
  if (start < 0 || end < start || end >= size) return null;
  return { start, end };
}

/** A text viewer needs a screenful, not a whole log file. */
const TEXT_LIMIT = 256 * 1024;

/** Remote text, capped: the upstream length header is not to be trusted. */
async function proxyText(url: URL, mime: string): Promise<Response> {
  const upstream = await fetch(url, {
    headers: { accept: "text/plain, text/*;q=0.9, */*;q=0.1" },
  }).catch(() => null);
  if (!upstream?.ok || !upstream.body) {
    return new Response("upstream fetch failed", { status: 502 });
  }

  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < TEXT_LIMIT) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value.subarray(0, TEXT_LIMIT - size));
    size += value.length;
  }
  await reader.cancel().catch(() => {});

  const body = new Uint8Array(Math.min(size, TEXT_LIMIT));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  return new Response(body, {
    headers: {
      "content-type": `${mime}; charset=utf-8`,
      "content-length": String(body.length),
      "cache-control": "no-store",
    },
  });
}

/** The stored `uri` a `weaver-media://local/<encodeURIComponent(uri)>`
 *  request names. It is the last path segment, decoded. */
function requestedUri(url: URL): string {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1] ?? "";
  return decodeURIComponent(last);
}

async function handleMediaRequest(request: Request): Promise<Response> {
  const uri = requestedUri(new URL(request.url));
  if (!uri) return new Response("missing uri", { status: 400 });

  const url = parseMediaUri(uri);
  if (!url) return new Response("not a media uri", { status: 400 });
  const allowed =
    isReferenced(uri) ||
    isPendingMedia(uri) ||
    (url.protocol === "file:" && inProject(fileURLToPath(url)));
  if (!allowed) {
    return new Response("uri is neither referenced nor in the project", {
      status: 403,
    });
  }

  const { mime, type } = mediaInfo(uri);
  if (url.protocol !== "file:") {
    if (type !== "text") {
      return new Response("remote media loads directly", { status: 400 });
    }
    return proxyText(url, mime);
  }

  const path = fileURLToPath(url);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return new Response("not a file", { status: 404 });

  const range = parseRange(request.headers.get("range"), info.size);
  const { start, end } = range ?? { start: 0, end: info.size - 1 };
  const stream = Readable.toWeb(
    createReadStream(path, { start, end }),
  ) as ReadableStream<Uint8Array>;

  return new Response(stream, {
    status: range ? 206 : 200,
    headers: {
      "content-type": mime,
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
      // Local files change under us; the renderer must not keep a stale copy.
      "cache-control": "no-store",
      ...(range
        ? { "content-range": `bytes ${start}-${end}/${info.size}` }
        : {}),
    },
  });
}

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_PROTOCOL, (request) => handleMediaRequest(request));
}
