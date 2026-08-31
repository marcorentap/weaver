import { z } from "zod";
import { defineKind } from "@repo/core";

/**
 * A media context block: one file, addressed by URI. What it *is* comes from
 * the file extension rather than a hand-set type field, so the state stays the
 * minimum needed to reconstruct the block.
 */
export const MEDIA_KIND = "media";

export type MediaType = "image" | "video" | "audio" | "pdf" | "unknown";

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
};

const UNKNOWN = { type: "unknown", mime: "application/octet-stream" } as const;

/** Last path segment, which is what a row shows instead of a full URI. */
export function mediaName(uri: string): string {
  const url = parseMediaUri(uri);
  if (!url) return uri;
  const segments = decodeURIComponent(url.pathname).split("/");
  return segments[segments.length - 1] || url.host || uri;
}

export function mediaInfo(uri: string): { type: MediaType; mime: string } {
  const url = parseMediaUri(uri);
  if (!url) return UNKNOWN;
  const name = url.pathname.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) return UNKNOWN;
  return EXTENSIONS[name.slice(dot + 1)] ?? UNKNOWN;
}

/**
 * What an `<img>`/`<video>` can actually load. A page served over http cannot
 * read `file://`, so local files go through the media route instead.
 */
export function mediaSrc(uri: string): string {
  const url = parseMediaUri(uri);
  if (!url) return uri;
  return url.protocol === "file:"
    ? `/api/media?uri=${encodeURIComponent(uri)}`
    : uri;
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
});
