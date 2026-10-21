import { isAbsolute } from "node:path";
import { ipcMain } from "electron";
import type { AdoptArtifactResult } from "../../shared/ipc-contract.js";
import { adoptSessionArtifact } from "../lib/artifacts.js";
import { registerPendingMedia } from "../lib/pending-media.js";

/**
 * Files dragged in from outside the app. The renderer receives the drop as a
 * DOM `File`, but a `File` is not a path and the page cannot read one: it has
 * no Node, and a `File`'s bytes never cross the IPC boundary here the way the
 * clipboard's do. `webUtils.getPathForFile` in the preload turns the dropped
 * `File` back into the path the OS handed Chromium, and this takes it from
 * there — copying it into the session's artifacts directory and handing back
 * the copy's path for a media block to point at.
 *
 * A path arrives from the renderer, so it is checked before it is used: it
 * must be absolute. The copy itself is the containment — nothing outside the
 * artifacts directory is written — so an absolute path anywhere on the disk
 * is fine, which is the whole point of a drag.
 */
export function registerArtifactHandlers(): void {
  ipcMain.handle(
    "artifacts:adopt",
    async (_, sessionId: string, path: string): Promise<AdoptArtifactResult> => {
      if (!isAbsolute(path)) {
        return { uri: null, error: `not an absolute path: ${path}` };
      }
      try {
        const uri = await adoptSessionArtifact(sessionId, path);
        // Same gap the pasted image has: the copy sits outside the project
        // and no stored block references it yet, so the media protocol would
        // refuse it until the next autosave — and a failed `<img>` never
        // retries. Registering it now is what lets the block render the
        // moment the renderer writes it.
        registerPendingMedia(uri);
        return { uri, error: null };
      } catch (error) {
        return {
          uri: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}
