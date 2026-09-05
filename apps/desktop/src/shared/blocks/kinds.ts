import { coreKinds, kindRegistry } from "@repo/core";
import { userKind } from "./user.js";
import { mediaKind } from "./media.js";
import { toolKind } from "./tool.js";

/**
 * Custom block kinds: media, user, and tool, on top of the core set. Each
 * kind's schema lives with its view, so this file is only the registry.
 */
export const kinds = kindRegistry([
  ...coreKinds,
  mediaKind,
  userKind,
  toolKind,
]);
