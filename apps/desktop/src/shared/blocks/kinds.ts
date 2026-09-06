import { coreKinds, kindRegistry, type KindRegistry } from "@repo/core";
import richMedia from "@plugins/rich-media";

/**
 * The graph's effective kind registry: the core kinds every graph ships with,
 * plus every `BlockKind` the bundled plugins register. Plugins contribute
 * kinds from their own `blocks/` directories; this file is only the merge
 * point, so the main process validates against the same set the renderer
 * renders.
 */
export const kinds: KindRegistry = kindRegistry([
  ...coreKinds,
  ...(richMedia.kinds ?? []),
]);