import { z } from "zod";
import { defineKind, type ContextImage } from "@repo/core";
import { languageForPath } from "../../languages.ts";

/**
 * A media context block, one file, addressed by URI. What it *is* comes from
 * the file extension rather than a hand-set type field, so the state stays the
 * minimum needed to reconstruct the block.
 */
export const MEDIA_KIND = "media";

export type MediaType =
  "image" | "video" | "audio" | "pdf" | "text" | "youtube" | "unknown";

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
  return url ? url.host || uri : uri;
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

/**
 * The mime types a provider takes as a picture: the raster formats every
 * OpenAI-compatible and Anthropic-shaped endpoint accepts as an `image_url`
 * content part. Deliberately short. Attaching an image a provider rejects is
 * not a smaller loss than not attaching it — it fails the whole request — so
 * `avif` and `bmp`, which the app renders and some models could take, are
 * left to whatever the file reads as instead of gambled on. (`svg` is not in
 * the running for a different reason: it is markup, and a content part is
 * for pixels. It reads as the text it is.)
 */
const ATTACHABLE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * The picture a media source contributes to a run — the URI the run's own
 * process reads, and the mime type it sends it as — or null when the source
 * names no picture a provider takes.
 *
 * One answer for both callers that need it: a media block serializing
 * itself, and the `read` tool handing back a file it was pointed at. So what
 * can be attached is decided in one place, and a picture the app shows and a
 * picture the model is given can never disagree about which files qualify.
 */
export function attachableImage(uri: string): ContextImage | null {
  const { type, mime } = mediaInfo(uri);
  return type === "image" && ATTACHABLE_MIME.has(mime)
    ? { uri, mimeType: mime }
    : null;
}

export const mediaState = z.object({
  uri: z
    .string()
    .refine(
      (uri) =>
        parseMediaUri(uri) !== null || (uri.length > 0 && !uri.includes("://")),
      { message: MEDIA_SCHEME_HINT },
    ),
  /**
   * Whether this block is what a `display_media` tool call produced, as
   * opposed to a file a person pasted or pointed at. The difference is not
   * in the file but in the block's past: a block the model asked for was a
   * tool call on the wire, and a block someone attached never was, so only
   * the former may replay as one (see `wire` below).
   *
   * Optional because every media block already saved in a session was
   * written before this field existed. Those must keep parsing, and a
   * missing flag has to mean exactly one thing — no call made this block —
   * so that they keep reading as the material they are instead of
   * pretending to be a call nobody can find in the transcript.
   */
  attached: z.boolean().optional(),
  /**
   * The assistant message of the run that made the call this block records,
   * for a block a call produced. It says which calls belonged to one message
   * — a model that asked for this picture and a `read` in the same turn sent
   * one assistant message with two `tool_calls`, not two messages — and that
   * grouping is part of what a replayed request has to reproduce. Opaque, and
   * absent for the same reason `attached` is: a media block already saved
   * was written before anyone recorded it, and a block nobody called has no
   * message to belong to. See `WirePart` in `@repo/core`.
   */
  turn: z.string().optional(),
  /**
   * The arguments of the `display_media` call that produced this block, as
   * the request carried them. Same reason as `turn` and `attached`: the
   * block's own fields are a reading of that call, and a reading that gains
   * or loses a key is a call the model never made. Absent for a block nobody
   * called, and for one saved before it was kept.
   */
  args: z.string().optional(),
});
export type MediaState = z.infer<typeof mediaState>;

export const mediaKind = defineKind({
  kind: MEDIA_KIND,
  schema: mediaState,
  // `snapshotBlock` prefixes the label itself; this only adds what's
  // specific to a media block.
  snapshot: (state) => `${mediaInfo(state.uri).type} at ${state.uri}`,
  // An image is the one media type a model can be handed the bytes of: a
  // video, a PDF and an audio file have no content part an OpenAI-shaped
  // request takes, and a text file is already readable as itself. The
  // description above goes either way, so a run on a model that cannot take
  // pictures still reads what the block says. The URI travels unresolved —
  // it is the request builder, not this, that has the run's merged
  // `WEAVER_PWD` to resolve a scheme-less path against.
  //
  // A block `display_media` produced is exempt: that call exists so the tool
  // can show a person something, and a picture shown to a person is not a
  // picture handed to the model. Sending it back would bill a run for an
  // image it never asked to look at, and would make the model's own view of
  // a file it chose to display part of every later replay. A model that does
  // want to look at a picture reads its path with the `read` tool, which
  // attaches the bytes on purpose. A file someone attached themselves is
  // unaffected: there the picture is what the person said.
  images: (state) => {
    if (state.attached) return [];
    const image = attachableImage(state.uri);
    return image ? [image] : [];
  },
  // The call, for a block a call produced: on the wire this block was an
  // assistant turn's `tool_calls` entry, answered by a `tool` message, so
  // replaying it as prose instead is a request whose prefix stops matching
  // the run that wrote it at that very block. Returning null for anything
  // else is what keeps a pasted image or a linked file out of that past —
  // nobody called a tool to produce it, so there is no call to reproduce,
  // and the document `snapshot` writes is the whole of what it says.
  //
  // `ctx.block.label` is the call's `label` argument: `display_media` writes
  // the model's own label straight onto the block it emits, so the block is
  // the record of that argument and nothing else needs to have kept it.
  //
  // The result text is coupled to `display_media`'s reply, in `execute` in
  // `apps/desktop/src/main/lib/run-agent.ts` (`added a media block for
  // ${params.uri}`): a replayed transcript is only a prefix of the request
  // the run actually sent if the `tool` message reads the same words, so
  // changing the tool's wording and this one apart turns every media block
  // into a cache miss from that call onward.
  wire: (state, ctx) =>
    state.attached
      ? {
          wire: "toolCall",
          name: "display_media",
          args:
            state.args ??
            JSON.stringify({ uri: state.uri, label: ctx.block.label }),
          result: `added a media block for ${state.uri}`,
          ...(state.turn === undefined ? {} : { turn: state.turn }),
        }
      : null,
  defaults: { uri: "file:///" },
});
