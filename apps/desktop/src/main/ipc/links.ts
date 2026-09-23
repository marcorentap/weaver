import { ipcMain } from "electron";
import type {
  LinkOption,
  LinkTypeDescriptor,
} from "../../shared/ipc-contract.js";
import { weaverRoot } from "../lib/project.js";
import { linkTypes, searchLinkOptions } from "../lib/links/registry.js";

/** Enough candidates to fill the completion menu several times over without
 *  sending a directory's worth of paths across the boundary. */
const SEARCH_LIMIT = 30;

/**
 * Serve the `@`-link completion menus. Type descriptors and candidate
 * searches both live main-side because the sources do: the project's file
 * tree and pi's skill discovery are filesystem work the renderer has no
 * access to.
 */
export function registerLinkHandlers(): void {
  ipcMain.handle("links:types", (): LinkTypeDescriptor[] => linkTypes());
  ipcMain.handle(
    "links:search",
    (
      _,
      type: string,
      query: string,
      pwd?: string,
    ): Promise<LinkOption[]> =>
      searchLinkOptions(type, query, {
        root: weaverRoot(pwd),
        limit: SEARCH_LIMIT,
      }),
  );
}
