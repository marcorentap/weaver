import { ipcMain } from "electron";
import type {
  LinkMaterial,
  LinkOption,
  LinkTypeDescriptor,
} from "../../shared/ipc-contract.js";
import { weaverRoot } from "../lib/project.js";
import { linkMaterials } from "../lib/links/material.js";
import { linkTypes, searchLinkOptions } from "../lib/links/registry.js";

/** Enough candidates to fill the completion menu several times over without
 *  sending a directory's worth of paths across the boundary. */
const SEARCH_LIMIT = 30;

/**
 * Serve the `@`-link completion menus, and the material a written reference
 * points at. Type descriptors, candidate searches and resolution all live
 * main-side because the sources do: the project's file tree and pi's skill
 * discovery are filesystem work the renderer has no access to.
 */
export function registerLinkHandlers(): void {
  ipcMain.handle("links:types", (): LinkTypeDescriptor[] => linkTypes());
  ipcMain.handle(
    "links:search",
    (_, type: string, query: string, pwd?: string): Promise<LinkOption[]> =>
      searchLinkOptions(type, query, {
        root: weaverRoot(pwd),
        limit: SEARCH_LIMIT,
      }),
  );
  ipcMain.handle(
    "links:materials",
    (_, text: string, pwd?: string): Promise<LinkMaterial[]> =>
      linkMaterials(text, weaverRoot(pwd)),
  );
}
