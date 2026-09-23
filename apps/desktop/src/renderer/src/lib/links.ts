import { useEffect, useState } from "react";
import type { LinkOption, LinkTypeDescriptor } from "@shared/ipc-contract.js";

/**
 * The link types the app can complete, learned once from the main process.
 * Types are registered main-side (see `main/lib/links/registry.ts`), so the
 * renderer never hardcodes a list that could drift from the providers that
 * actually answer searches. Returns `[]` until the first load resolves; an
 * empty list simply means the completion menu has nothing to show yet.
 */
export function useLinkTypes(): LinkTypeDescriptor[] {
  const [types, setTypes] = useState<LinkTypeDescriptor[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.api.links
      .types()
      .then((loaded) => {
        if (!cancelled) setTypes(loaded);
      })
      .catch(() => {
        // A failed load leaves the menu empty rather than breaking the
        // editor; the next mount retries.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return types;
}

/** Candidates for one type's value half. Thin wrapper so components depend
 *  on the intent, not the channel name. `pwd` is the merged `WEAVER_PWD` at
 *  the block being edited, so a `@file:` search completes against that
 *  block's project the same way an inference run there would start in it;
 *  undefined falls back to the process's project root. */
export function searchLinkOptions(
  type: string,
  query: string,
  pwd?: string,
): Promise<LinkOption[]> {
  return window.api.links.search(type, query, pwd);
}
