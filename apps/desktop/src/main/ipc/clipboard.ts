import { clipboard, ipcMain, nativeImage } from "electron";
import type { ClipboardPaste } from "../../shared/ipc-contract.js";
import { writeSessionArtifact } from "../lib/artifacts.js";
import { registerPendingMedia } from "../lib/pending-media.js";

/**
 * Clipboard image types the media kind can render from the extension the
 * artifact keeps. PNG is first because it is the one every platform and every
 * source application produces, and the one a re-encode lands in; the rest are
 * written as they came, so a copied GIF stays animated and a copied screenshot
 * is not decoded and recompressed for nothing.
 */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

/**
 * The clipboard's picture, as bytes plus the extension the artifact should
 * carry, or null when the clipboard holds no image at all.
 *
 * Electron 44's clipboard is MIME-based and asynchronous (`read()`, `readText()`,
 * `has()`); the `readImage()`/`availableFormats()` pair earlier versions had is
 * gone, so what a picture is has to be read off the types the item advertises.
 * One logical item can offer several representations of the same picture — a
 * browser writes both `image/png` and its own private format, macOS a TIFF —
 * and PNG is preferred wherever it is offered.
 *
 * A type the media kind has no viewer for (macOS's TIFF, say) is decoded and
 * re-encoded to PNG instead of being stored under its own extension: the block
 * exists to be looked at, and a `.tiff` artifact would render as an unknown
 * file. `createFromBuffer` answers an empty image for anything it cannot
 * decode, and those bytes are then kept as they arrived — an unknown but real
 * file beats refusing a paste the clipboard did hold.
 */
async function readClipboardImage(
  items: Electron.ClipboardItem[],
): Promise<{ bytes: Uint8Array; extension: string } | null> {
  for (const item of items) {
    const type =
      item.types.find((candidate) => candidate === "image/png") ??
      item.types.find((candidate) => candidate.startsWith("image/"));
    if (!type) continue;
    const blob = await item.getType(type);
    if (!(blob instanceof Blob)) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const extension = IMAGE_TYPES[type];
    if (extension) return { bytes, extension };
    const decoded = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (!decoded.isEmpty()) return { bytes: decoded.toPNG(), extension: "png" };
    return { bytes, extension: "bin" };
  }
  return null;
}

/**
 * The clipboard, for `ctrl+v` on the chat page. Reading it is main's work
 * for the same reason every other piece of filesystem work is: the renderer
 * has no Node, and a pasted image has to become a file before it can become
 * a block.
 *
 * An image is written into the session's artifacts directory under the
 * extension its clipboard type implies, or as PNG when it had to be
 * re-encoded (`~/.weaver/artifacts/<session>/<uuid>.png`). The extension is
 * known rather than guessed, because it is what makes the media kind render
 * the file as the kind of thing it is.
 *
 * Text is handed over as it is, and the renderer decides what block it
 * becomes. A clipboard holding neither comes back as null so the renderer
 * can say so instead of writing an empty block.
 */
export function registerClipboardHandlers(): void {
  ipcMain.handle(
    "clipboard:paste",
    async (_, sessionId: string): Promise<ClipboardPaste | null> => {
      const image = await readClipboardImage(await clipboard.read());
      if (image) {
        const path = await writeSessionArtifact(
          sessionId,
          image.bytes,
          image.extension,
        );
        // The media protocol serves a URI only when a stored media block
        // references it or the file sits in the project. This one is neither
        // until the renderer's next autosave, and a failed `<img>` never
        // retries, so the block would render blank until a reload landed
        // after persistence. Registering it here — before the renderer has
        // even seen the path — closes that gap exactly as `display_media`
        // does for the files an agent shows.
        registerPendingMedia(path);
        return { kind: "image", uri: path };
      }
      const text = await clipboard.readText();
      return text.length > 0 ? { kind: "text", text } : null;
    },
  );
}
