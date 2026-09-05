import { mediaProtocolUrl } from "@shared/ipc-contract.js";
import {
  MEDIA_KIND,
  MEDIA_SCHEME_HINT,
  mediaInfo,
  mediaKind,
  mediaName,
  mediaState,
  parseMediaUri,
  youtubeVideoId,
} from "@shared/blocks/media.js";
import type { MediaState, MediaType } from "@shared/blocks/media.js";

// Everything else about a media block — its kind constant, schema, uri
// parsing, and type/mime sniffing — is shared with the main process (see
// `@shared/blocks/media.ts`), which needs the same logic for the media
// protocol handler and the store's seed/validation. `mediaSrc` alone stays
// here: it is the one piece of "what does a media URI resolve to" that only
// makes sense in a page that can load a `weaver-media://` URL.
export {
  MEDIA_KIND,
  MEDIA_SCHEME_HINT,
  mediaInfo,
  mediaKind,
  mediaName,
  mediaState,
  parseMediaUri,
};
export type { MediaState, MediaType };

/**
 * What an `<img>`/`<video>` can actually load, or what `fetch` can read. A
 * renderer page cannot read `file://` bytes, and a cross-origin text file is
 * unreadable without CORS headers, so both go through the `weaver-media://`
 * protocol the main process registers (see `mediaProtocolUrl`).
 */
export function mediaSrc(uri: string): string {
  const url = parseMediaUri(uri);
  if (!url) return uri;
  const id = youtubeVideoId(url);
  if (id) return `https://www.youtube.com/embed/${id}`;
  return url.protocol === "file:" || mediaInfo(uri).type === "text"
    ? mediaProtocolUrl(uri)
    : uri;
}
