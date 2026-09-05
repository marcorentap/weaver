import { z } from "zod";
import { defineKind } from "@repo/core";
import { languageForPath } from "../languages.js";

/**
 * A media context block: one file, addressed by URI. What it *is* comes from
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

export const MEDIA_SCHEME_HINT = "uri must be http://, https:// or file://";

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

/** Last path segment, which is what a row shows instead of a full URI. */
export function mediaName(uri: string): string {
  const url = parseMediaUri(uri);
  if (!url) return uri;
  const segments = decodeURIComponent(url.pathname).split("/");
  return segments[segments.length - 1] || url.host || uri;
}

/**
 * `EXTENSIONS` covers everything with a dedicated non-text viewer (images,
 * video, audio, pdf) plus a handful of always-plain-text extensions with
 * their own mime type. Anything else `languageForPath` recognises — every
 * source-code extension `CodeBlock` can highlight — is text too, just with
 * no more specific mime than `text/plain`; only that fallback keeps a `.ts`
 * or `.py` file from landing on "No viewer for this extension."
 */
export function mediaInfo(uri: string): { type: MediaType; mime: string } {
  const url = parseMediaUri(uri);
  if (!url) return UNKNOWN;
  if (youtubeVideoId(url)) return { type: "youtube", mime: "text/html" };
  const name = url.pathname.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) return UNKNOWN;
  const known = EXTENSIONS[name.slice(dot + 1)];
  if (known) return known;
  if (languageForPath(name)) return { type: "text", mime: "text/plain" };
  return UNKNOWN;
}

export const mediaState = z.object({
  uri: z.string().refine((uri) => parseMediaUri(uri) !== null, {
    message: MEDIA_SCHEME_HINT,
  }),
});
export type MediaState = z.infer<typeof mediaState>;

export const mediaKind = defineKind({
  kind: MEDIA_KIND,
  schema: mediaState,
  snapshot: (state, ctx) =>
    `${ctx.block.label}: ${mediaInfo(state.uri).type} at ${state.uri}`,
  defaults: { uri: "file:///" },
});
