import { clipboard, ipcMain } from "electron";
import type { ClipboardPaste } from "../../shared/ipc-contract.js";
import { writeSessionArtifact } from "../lib/artifacts.js";
import { registerPendingMedia } from "../lib/pending-media.js";

/**
 * The clipboard, for `ctrl+v` on the chat page. Reading it is main's work
 * for the same reason every other piece of filesystem work is: the renderer
 * has no Node, and a pasted image has to become a file before it can become
 * a block.
 *
 * An image is written as PNG (`~/.weaver/artifacts/<session>/<uuid>.png`).
 * That is the one encoding `NativeImage.toPNG()` produces on every platform,
 * so the extension is known rather than guessed from whatever format the
 * source application put on the clipboard — macOS, in particular, offers
 * TIFF there, and a `.tiff` artifact the media protocol has no viewer for
 * would be worse than a re-encoded PNG.
 *
 * Text is handed over as it is, and the renderer decides what block it
 * becomes. A clipboard holding neither comes back as null so the renderer
 * can say so instead of writing an empty block.
 */
export function registerClipboardHandlers(): void {
  ipcMain.handle(
    "clipboard:paste",
    async (_, sessionId: string): Promise<ClipboardPaste | null> => {
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        const path = await writeSessionArtifact(
          sessionId,
          image.toPNG(),
          "png",
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
      const text = clipboard.readText();
      return text.length > 0 ? { kind: "text", text } : null;
    },
  );
}
