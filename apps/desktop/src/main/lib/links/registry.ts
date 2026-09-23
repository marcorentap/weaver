import type {
  LinkOption,
  LinkTypeDescriptor,
} from "../../../shared/ipc-contract.js";
import { fileProvider } from "./file.js";
import { skillProvider } from "./skill.js";
import type { LinkProvider, LinkSearchContext } from "./types.js";

/**
 * Every `@`-link type the app can complete, in the order the type menu
 * shows them. This array is the one registration point: a new link type is
 * a new provider here, and both the renderer's type completion and its
 * searches pick it up without a second list to keep in sync. A future type
 * whose candidates come from a plugin rather than the app would slot in the
 * same way.
 */
export const LINK_PROVIDERS: readonly LinkProvider[] = [
  fileProvider,
  skillProvider,
];

/** The descriptors half of the providers: everything the renderer needs to
 *  complete the type half of a link, without the `search` function, which
 *  cannot cross the IPC boundary. */
export function linkTypes(): LinkTypeDescriptor[] {
  return LINK_PROVIDERS.map(({ id, label, description }) => ({
    id,
    label,
    description,
  }));
}

/** Complete the value half of a `@<type>:` link. An unknown type returns no
 *  options rather than throwing: the renderer can have a stale provider
 *  list after a restart, and an empty menu is a better failure than a
 *  crashed keystroke. A provider that throws is caught for the same reason. */
export async function searchLinkOptions(
  type: string,
  query: string,
  ctx: LinkSearchContext,
): Promise<LinkOption[]> {
  const provider = LINK_PROVIDERS.find((candidate) => candidate.id === type);
  if (!provider) return [];
  try {
    return await provider.search(query, ctx);
  } catch {
    return [];
  }
}
