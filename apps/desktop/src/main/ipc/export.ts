import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { ZipFile } from "yazl";
import {
  messagesOfGraph,
  type BlockGraph,
  type KindRegistry,
} from "@repo/core";
import { getStore } from "../lib/store.js";
import { loadedPlugins } from "../lib/plugins.js";
import type { ExportResult } from "../../shared/ipc-contract.js";

/**
 * A conversation as JSONL: one JSON object per turn, in graph order, with
 * the role each block's kind already gives it. This is the same view a run
 * over the session reads (`messagesOfGraph`), not a re-rendering of it, so
 * an exported conversation is what the model saw rather than a second
 * interpretation of the blocks that could disagree with the first. Hidden
 * blocks, kinds marked `context: false` (the environment block) and blank
 * turns contribute nothing, exactly as they contribute nothing to a run.
 *
 * Pictures travel as the URIs they were stored as, beside the text
 * description the snapshot already wrote: an export cannot carry the bytes
 * of a local file, but it can name them.
 */
function conversationJsonl(graph: BlockGraph, registry: KindRegistry): string {
  return (
    messagesOfGraph(graph, registry)
      .map((message) =>
        JSON.stringify({
          role: message.role,
          content: message.content,
          ...(message.images?.length ? { images: message.images } : {}),
        }),
      )
      .join("\n") + "\n"
  );
}

/** The file one conversation becomes: `weaver-ses-<id>.jsonl`.
 *
 * The id rather than the session name, because the name is display-only in
 * the store: two sessions may share one, a user may rename either at any
 * time, and a name carries characters (separators, Windows' refusals) that a
 * zip entry cannot, all of which would have to be papered over with
 * sanitizing and de-duplication.
 *
 * A session id is a `crypto.randomUUID()` (see `newId`), so it is unique and
 * filesystem-safe by construction, and it is what anything reading the export
 * back matches a file to a session by. */
function conversationFile(id: string): string {
  return `weaver-ses-${id}.jsonl`;
}

/**
 * Writes every conversation to a zip of `.jsonl` files, where the user
 * chooses to put it. `showSaveDialog` is the whole reason this lives in
 * main: the renderer has no filesystem.
 *
 * The archive is built by `yazl`, which switches to the zip64 extensions by
 * itself once an entry or an offset outgrows the classic format's 32-bit
 * fields (or the entry count outgrows its 16-bit one), and streams that to
 * the file instead of assembling it in memory first. Rolling the format by
 * hand is what made those ceilings ours to refuse: the old writer had to
 * turn down anything past 4 GiB or 65,535 entries because a truncated
 * archive that still opens is worse than an error. A library that emits
 * zip64 has no such cliff to guard.
 */
export function registerExportHandlers(): void {
  ipcMain.handle(
    "export:conversations",
    async (event): Promise<ExportResult> => {
      const store = getStore();
      const { kinds } = loadedPlugins();
      const entries: { name: string; data: string }[] = [];
      const sessions = store.listGraphs();
      let skipped = 0;
      for (const session of sessions) {
        // A graph holding a block whose kind no longer loads (a plugin removed
        // from the plugins directory) cannot be snapshotted, and one such
        // session must not cost the user every other one. It is left out and
        // counted; the result says how many, so the loss is reported rather
        // than silently papered over.
        let data: string;
        try {
          data = conversationJsonl(store.loadGraph(session.id), kinds);
        } catch {
          skipped++;
          continue;
        }
        entries.push({ name: conversationFile(session.id), data });
      }

      const window = BrowserWindow.fromWebContents(event.sender);
      const path = await savePath(window);
      if (path === null)
        return {
          canceled: true,
          path: null,
          conversations: 0,
          skipped: 0,
          error: null,
        };

      try {
        await writeZip(entries, path);
      } catch (error) {
        // A half-written archive is not something the user asked for, and
        // the save dialog already settled that overwriting this path was
        // fine, so a failed export leaves nothing behind to be mistaken for
        // a complete one.
        await unlink(path).catch(() => {});
        return {
          canceled: false,
          path: null,
          conversations: 0,
          skipped: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        canceled: false,
        path,
        conversations: entries.length,
        skipped,
        error: null,
      };
    },
  );
}

/** Writes `entries` as a zip at `path`. Every entry is deflated and its
 *  mtime is the moment of the export: the archive is a snapshot of the
 *  store, so a file's own timestamp inside it says nothing the JSONL does
 *  not already say better. */
async function writeZip(
  entries: readonly { name: string; data: string }[],
  path: string,
): Promise<void> {
  const archive = new ZipFile();
  for (const entry of entries) {
    archive.addBuffer(Buffer.from(entry.data, "utf8"), entry.name);
  }
  archive.end();
  await pipeline(archive.outputStream, createWriteStream(path));
}

async function savePath(window: BrowserWindow | null): Promise<string | null> {
  const options = {
    title: "Export conversations",
    defaultPath: `weaver-conversations-${new Date().toISOString().slice(0, 10)}.zip`,
    filters: [{ name: "Zip archive", extensions: ["zip"] }],
  };
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}
