import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { MEDIA_KIND, mediaInfo, parseMediaUri } from "@/blocks/media";
import { getStore } from "@/lib/store";

/**
 * Serves `file://` media to the browser, which cannot load local files from an
 * http page itself.
 *
 * Only files a media block actually points at are served, so this stays a
 * viewer for the store's own content rather than a read-anything oracle on
 * localhost.
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

export async function GET(request: Request): Promise<Response> {
  const uri = new URL(request.url).searchParams.get("uri");
  if (!uri) return new Response("missing uri", { status: 400 });

  const url = parseMediaUri(uri);
  if (!url || url.protocol !== "file:") {
    return new Response("uri must be a file:// media uri", { status: 400 });
  }
  if (!isReferenced(uri)) {
    return new Response("no media block references this uri", { status: 403 });
  }

  const path = fileURLToPath(url);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return new Response("not a file", { status: 404 });

  const { mime } = mediaInfo(uri);
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
