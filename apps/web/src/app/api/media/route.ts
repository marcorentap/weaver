import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { MEDIA_KIND, mediaInfo, parseMediaUri } from "@/blocks/media";
import { projectRoot } from "@/lib/project";
import { getStore } from "@/lib/store";

/**
 * Serves media the browser cannot fetch itself: `file://` bytes, which an http
 * page may not read, and remote text, which `fetch` may not read without CORS
 * headers on the origin.
 *
 * What may be served is either something a media block already points at, or
 * a file inside the project directory. The second rule exists because an
 * agent's output is live: it displays a file it just read and the block
 * showing it is only in the browser until the next autosave, so a
 * store-reference check alone would blank every fresh block for a few
 * seconds. Neither rule serves anything outside the project it was not
 * already asked to.
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

/** Whether `path` is inside the project this server was started in. */
function inProject(path: string): boolean {
  const root = projectRoot();
  const target = resolve(path);
  return target === root || target.startsWith(`${root}/`);
}

/** `bytes=start-end`, the only form browsers send for media. */
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

/** A text viewer needs a screenful, not a whole log server. */
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

export async function GET(request: Request): Promise<Response> {
  const uri = new URL(request.url).searchParams.get("uri");
  if (!uri) return new Response("missing uri", { status: 400 });

  const url = parseMediaUri(uri);
  if (!url) return new Response("not a media uri", { status: 400 });
  const allowed =
    isReferenced(uri) ||
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
      // Local files change under us; the browser must not keep a stale copy.
      "cache-control": "no-store",
      ...(range
        ? { "content-range": `bytes ${start}-${end}/${info.size}` }
        : {}),
    },
  });
}
