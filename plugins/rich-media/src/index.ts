import { definePlugin } from "@repo/plugins";
import { assistantKind } from "./blocks/assistant/index.ts";
import { mediaKind } from "./blocks/media/index.ts";
import { toolKind } from "./blocks/tool/index.ts";
import { userKind } from "./blocks/user/index.ts";

/**
 * Rich media: context blocks for real files, recorded tool calls and the two
 * sides of a conversation. Ships the media (`MEDIA_KIND`), tool (`TOOL_KIND`),
 * user (`USER_KIND`) and assistant (`ASSISTANT_KIND`) kinds the harness did
 * before the plugins split, plus the file-language map those kinds render
 * with.
 */
export const richMedia = definePlugin({
  id: "rich-media",
  name: "Rich media",
  description: "Block kinds for media files, tool calls and hand-written text.",
  kinds: [mediaKind, toolKind, userKind, assistantKind],
});

export default richMedia;

export * from "./blocks/index.ts";
export { languageForPath } from "./languages.ts";
