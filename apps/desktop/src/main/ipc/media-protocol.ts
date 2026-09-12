import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { protocol, type CustomScheme } from "electron";
import { mergedEnvironment, WEAVER_PWD } from "@repo/core";
import { MEDIA_KIND, mediaInfo, parseMediaUri } from "@plugins/rich-media";
import { MEDIA_PROTOCOL } from "../../shared/ipc-contract.js";
import { projectRoot } from "../lib/project.js";
import { getStore } from "../lib/store.js";
import { isPendingMedia as isPendingMediaThere, pendingMediaUris } from "../lib/pending-media.js";

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
 * file inside the project directory, or a URI the `display_media` tool has
 * just handed to a live agent run (see `pending-media.ts`). The second and
 * third rules exist because an agent's output is live. It shows a file it
 * just read or wrote, and the block showing it is only in the renderer
 * until the next autosave, so a store-reference check alone would blank
 * every fresh block for a few seconds. The first and third rules only let
 * through a URI a block or run already points at.
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

/**
 * The `WEAVER_PWD` a scheme-less media uri resolves against: the merged
 * environment of a stored media block naming that uri, or the project root
 * when no block names it (or none of them sets the variable). The renderer
 * normally resolves a media block's relative path before asking (see
 * `resolveMediaUri`), so this only ever matters for a relative path an agent
 * asked `display_media` to show, which lands here raw.
 */
function pwdForMediaUri(uri: string): string {
  const store = getStore();
  for (const record of store.listGraphs()) {
    const graph = store.loadGraph(record.id);
    for (const id of Object.keys(graph.blocks)) {
      const block = graph.blocks[id];
      if (!block || block.kind !== MEDIA_KIND || block.data.uri !== uri) continue;
      const pwd = mergedEnvironment(graph, id)[WEAVER_PWD];
      if (pwd) return isAbsolute(pwd) ? pwd : resolve(projectRoot(), pwd);
    }
  }
  return projectRoot();
}

/** The absolute filesystem path a scheme-less media `uri` names. */
function schemeLessPath(uri: string): string {
  return isAbsolute(uri) ? uri : resolve(pwdForMediaUri(uri), uri);
}

/**
 * Whether `path` is what some stored media block's scheme-less uri resolves
 * to. A block written as a relative path against a `WEAVER_PWD` asks the
 * protocol by its absolute form, so the plain raw-uri reference check alone
 * would turn it away every time; this resolves each stored scheme-less uri
 * the same way it resolves and compares.
 */
function isStoredMediaPath(path: string): boolean {
  const want = resolve(path);
  const store = getStore();
  for (const record of store.listGraphs()) {
    const graph = store.loadGraph(record.id);
    for (const id of Object.keys(graph.blocks)) {
      const block = graph.blocks[id];
      if (!block || block.kind !== MEDIA_KIND) continue;
      const uri = block.data.uri;
      if (typeof uri !== "string" || parseMediaUri(uri) !== null) continue;
      const pwd = mergedEnvironment(graph, id)[WEAVER_PWD];
      const base = pwd
        ? isAbsolute(pwd)
          ? pwd
          : resolve(projectRoot(), pwd)
        : projectRoot();
      if (resolve(base, uri) === want) return true;
    }
  }
  return false;
}

/** Same as `isStoredMediaPath`, for a URI a live agent run asked to show
 *  (see pending-media.ts). Its working directory is not recorded, so a
 *  relative pending URI resolves against the project root; a relative path
 *  against an environment `WEAVER_PWD` only clears once the block autosaves
 *  and the stored check above covers it — a sub-second gap. */
function isPendingMediaPath(path: string): boolean {
  const want = resolve(path);
  for (const uri of pendingMediaUris()) {
    if (parseMediaUri(uri) !== null) continue;
    if (resolve(projectRoot(), uri) === want) return true;
  }
  return false;
}

async function handleMediaRequest(request: Request): Promise<Response> {
  const uri = requestedUri(new URL(request.url));
  if (!uri) return new Response("missing uri", { status: 400 });

  const url = parseMediaUri(uri);
  // Scheme-less paths are served as files: rendered as an absolute `file://`
  // URI by the renderer, or resolved here against the merged `WEAVER_PWD`
  // when one arrives raw. Everything else rides the existing file/remote
  // logic below.
  const local =
    url?.protocol === "file:"
      ? fileURLToPath(url)
      : url === null
        ? schemeLessPath(uri)
        : null;
  const allowed =
    isReferenced(uri) ||
    isPendingMediaThere(uri) ||
    (local !== null &&
      (inProject(local) || isStoredMediaPath(local) || isPendingMediaPath(local)));
  if (!allowed) {
    return new Response("uri is neither referenced nor in the project", {
      status: 403,
    });
  }

  const { mime, type } = mediaInfo(uri);
  if (url && url.protocol !== "file:") {
    if (type !== "text") {
      return new Response("remote media loads directly", { status: 400 });
    }
    return proxyText(url, mime);
  }
  if (local === null) {
    return new Response("not a media uri", { status: 400 });
  }

  const info = await stat(local).catch(() => null);
  if (!info?.isFile()) return new Response("not a file", { status: 404 });

  const range = parseRange(request.headers.get("range"), info.size);
  const { start, end } = range ?? { start: 0, end: info.size - 1 };
  const stream = Readable.toWeb(
    createReadStream(local, { start, end }),
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
