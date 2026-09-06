import { definePlugin } from "@repo/plugins";
import { mediaKind } from "./blocks/media/index.ts";
import { toolKind } from "./blocks/tool/index.ts";
import { userKind } from "./blocks/user/index.ts";

/**
 * Rich media: context blocks for real files and recorded tool calls. Ships
 * the media (`MEDIA_KIND`), tool (`TOOL_KIND`) and user (`USER_KIND`) kinds
 * the harness did before the plugins split, plus the file-language map those
 * kinds render with.
 */
export const richMedia = definePlugin({
  id: "rich-media",
  name: "Rich media",
  description:
    "Block kinds for media files, tool calls and hand-written text.",
  kinds: [mediaKind, toolKind, userKind],
});

export default richMedia;

export * from "./blocks/index.ts";
export { languageForPath } from "./languages.ts";