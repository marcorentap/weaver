import { useEffect, useState } from "react";
import type { LinkOption, LinkTypeDescriptor } from "@shared/ipc-contract.js";

/**
 * The link types the app can complete, learned once from the main process.
 * Types are registered main-side (see `main/lib/links/registry.ts`), so the
 * renderer never hardcodes a list that could drift from the providers that
 * actually answer searches. `types` is `[]` until the first load resolves;
 * `failed` says the load never landed, which the menu reports rather than
 * showing an empty type list that reads as "no such link".
 */
export function useLinkTypes(): {
  types: LinkTypeDescriptor[];
  failed: boolean;
} {
  const [state, setState] = useState<{
    types: LinkTypeDescriptor[];
    failed: boolean;
  }>({ types: [], failed: false });
  useEffect(() => {
    let cancelled = false;
    void window.api.links
      .types()
      .then((types) => {
        if (!cancelled) setState({ types, failed: false });
      })
      .catch(() => {
        // Keep the editor usable; the next mount retries, and the menu has
        // a notice to show meanwhile.
        if (!cancelled) setState({ types: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
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
