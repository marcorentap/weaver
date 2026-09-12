import { mediaProtocolUrl } from "@shared/ipc-contract.js";
import {
  MEDIA_KIND,
  MEDIA_SCHEME_HINT,
  mediaInfo,
  mediaKind,
  mediaName,
  mediaState,
  parseMediaUri,
  resolveMediaUri,
  youtubeVideoId,
} from "@plugins/rich-media";
import type { MediaState, MediaType } from "@plugins/rich-media";

// Everything else about a media block, its kind constant, schema, uri
// parsing, and type/mime sniffing, ships with the rich-media plugin, which
// the main process imports for the media protocol handler and the store's
// seed/validation. `mediaSrc` alone stays here. It is the one piece of "what
// does a media URI resolve to" that only makes sense in a page that can load
// a `weaver-media://` URL.
export {
  MEDIA_KIND,
  MEDIA_SCHEME_HINT,
  mediaInfo,
  mediaKind,
  mediaName,
  mediaState,
  parseMediaUri,
  resolveMediaUri,
};
export type { MediaState, MediaType };

/**
 * What an `<img>`/`<video>` can actually load, or what `fetch` can read. A
 * renderer page cannot read `file://` bytes, and a cross-origin text file is
 * unreadable without CORS headers, so both go through the `weaver-media://`
 * protocol the main process registers (see `mediaProtocolUrl`).
 *
 * A scheme-less filesystem path (absolute, or relative to `pwd`) cannot be
 * loaded by the page any more than a `file://` URI can, so it is resolved to
 * an absolute `file://` URL first — against `pwd`, the merged environment's
 * `WEAVER_PWD` when one applies to this block — and then served through the
 * same protocol. Without a `pwd`, a relative path cannot be resolved here or
 * anywhere else, so it is returned unresolved rather than guessed.
 */
export function mediaSrc(uri: string, pwd?: string): string {
  const url = parseMediaUri(uri);
  if (url) {
    const id = youtubeVideoId(url);
    if (id) return `https://www.youtube.com/embed/${id}`;
    return url.protocol === "file:" || mediaInfo(uri).type === "text"
      ? mediaProtocolUrl(uri)
      : uri;
  }
  const resolved = resolveMediaUri(uri, pwd);
  return resolved ? mediaProtocolUrl(resolved) : uri;
}