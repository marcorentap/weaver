import { z } from "zod";
import { defineKind } from "@repo/core";
import { languageForPath } from "../../languages.ts";

/**
 * A media context block, one file, addressed by URI. What it *is* comes from
 * the file extension rather than a hand-set type field, so the state stays the
 * minimum needed to reconstruct the block.
 */
export const MEDIA_KIND = "media";

export type MediaType =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "youtube"
  | "unknown";

/** Schemes worth supporting: the web, and the machine the harness runs on. */
const SCHEMES = new Set(["http:", "https:", "file:"]);

/**
 * A media block may also be a scheme-less filesystem path, absolute
 * (`/tmp/out.png`) or relative (`./logo.png`, `screenshot.png`), resolved
 * against the merged environment's `WEAVER_PWD` when one applies. That is
 * why `parseMediaUri` yielding `null` does not mean the block is broken.
 */
export const MEDIA_SCHEME_HINT =
  "media: an http(s):// or file:// URL, or a filesystem path";

export function parseMediaUri(uri: string): URL | null {
  try {
    const url = new URL(uri);
    return SCHEMES.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/**
 * The video id out of any of YouTube's URL shapes: a watch link, a shortened
 * `youtu.be` link, an `/embed/` link already, or a Shorts link. `null` for
 * anything else, including a YouTube URL that isn't actually a video (the
 * channel or search page, say).
 */
export function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.replace(/^(www|m)\./, "");
  if (host === "youtu.be") return url.pathname.slice(1) || null;
  if (host !== "youtube.com") return null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const embed = url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/);
  return embed ? (embed[1] ?? null) : null;
}

const EXTENSIONS: Record<string, { type: MediaType; mime: string }> = {
  png: { type: "image", mime: "image/png" },
  jpg: { type: "image", mime: "image/jpeg" },
  jpeg: { type: "image", mime: "image/jpeg" },
  gif: { type: "image", mime: "image/gif" },
  webp: { type: "image", mime: "image/webp" },
  avif: { type: "image", mime: "image/avif" },
  svg: { type: "image", mime: "image/svg+xml" },
  mp4: { type: "video", mime: "video/mp4" },
  webm: { type: "video", mime: "video/webm" },
  mov: { type: "video", mime: "video/quicktime" },
  mkv: { type: "video", mime: "video/x-matroska" },
  mp3: { type: "audio", mime: "audio/mpeg" },
  wav: { type: "audio", mime: "audio/wav" },
  ogg: { type: "audio", mime: "audio/ogg" },
  flac: { type: "audio", mime: "audio/flac" },
  m4a: { type: "audio", mime: "audio/mp4" },
  pdf: { type: "pdf", mime: "application/pdf" },
  txt: { type: "text", mime: "text/plain" },
  log: { type: "text", mime: "text/plain" },
  csv: { type: "text", mime: "text/csv" },
  md: { type: "text", mime: "text/markdown" },
  markdown: { type: "text", mime: "text/markdown" },
};

const UNKNOWN = { type: "unknown", mime: "application/octet-stream" } as const;

/**
 * Collapse a posix path: drop `.` segments and trailing slashes, fold `..`
 * against the segment before it. `..` stacking past an absolute root is
 * dropped (a path cannot climb above `/`); a relative path's own leading
 * `..` is kept, since joining its base still has to work.
 */
function normalizeMediaPath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
    } else {
      parts.push(segment);
    }
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined;
}

/**
 * Turn a media block's `uri` into the address the renderer can load and the
 * media protocol can serve. A scheme URI (`http(s)://`, `file://`) passes
 * through untouched. A scheme-less path becomes a `file://` URL; a relative
 * one is resolved against `pwd` — the merged environment's `WEAVER_PWD`.
 * Returns `null` when the block names a relative path but no `pwd` was
 * given, so it cannot be resolved.
 */
export function resolveMediaUri(
  uri: string,
  pwd: string | undefined,
): string | null {
  if (parseMediaUri(uri) !== null) return uri;
  if (uri.length === 0) return null;
  if (uri.startsWith("/")) {
    // An absolute path carries its own resolution; no pwd needed.
    return `file://${encodeURI(normalizeMediaPath(uri))}`;
  }
  if (!pwd?.startsWith("/")) return null; // a relative pwd is ambiguous
  return `file://${encodeURI(normalizeMediaPath(`${pwd}/${uri}`))}`;
}

/**
 * Last path segment, which is what a row shows instead of a full URI. For a
 * scheme-less path the whole string is the path, so it is split the same way
 * a URL's pathname is.
 */
export function mediaName(uri: string): string {
  const url = parseMediaUri(uri);
  const raw = url ? url.pathname : uri;
  const segments = decodeURIComponent(raw).split("/");
  const last = segments[segments.length - 1];
  if (last) return last;
  return url ? (url.host || uri) : uri;
}

/**
 * `EXTENSIONS` covers everything with a dedicated non-text viewer (images,
 * video, audio, pdf) plus a handful of always-plain-text extensions with
 * their own mime type. Anything else `languageForPath` recognises is text
 * too, just with no more specific mime than `text/plain`. That set is every
 * source-code extension that `CodeBlock` can highlight, and this fallback
 * is what keeps a `.ts` or `.py` file from landing on "No viewer for this
 * extension." A scheme-less media path names its own file, and the renderer
 * resolves a relative one against the merged `WEAVER_PWD` before it ever
 * calls this, so here a path's tail is the file it means and the type comes
 * from that extension either way.
 */
export function mediaInfo(uri: string): { type: MediaType; mime: string } {
  const url = parseMediaUri(uri);
  if (url && youtubeVideoId(url)) return { type: "youtube", mime: "text/html" };
  const rawName = url ? url.pathname : uri;
  const name = rawName.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) return UNKNOWN;
  const known = EXTENSIONS[name.slice(dot + 1)];
  if (known) return known;
  if (languageForPath(name)) return { type: "text", mime: "text/plain" };
  return UNKNOWN;
}

export const mediaState = z.object({
  uri: z
    .string()
    .refine(
      (uri) =>
        parseMediaUri(uri) !== null ||
        (uri.length > 0 && !uri.includes("://")),
      { message: MEDIA_SCHEME_HINT },
    ),
});
export type MediaState = z.infer<typeof mediaState>;

export const mediaKind = defineKind({
  kind: MEDIA_KIND,
  schema: mediaState,
  // `snapshotBlock` prefixes the label itself; this only adds what's
  // specific to a media block.
  snapshot: (state) => `${mediaInfo(state.uri).type} at ${state.uri}`,
  defaults: { uri: "file:///" },
});