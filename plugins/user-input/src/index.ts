import { definePlugin } from "@repo/plugins";
import { multichoiceKind } from "./blocks/multichoice/index.ts";
import { askUserTool } from "./tools/ask-user/index.ts";

/**
 * User input: questions the agent raises and the user answers inside the
 * graph. Ships the `multichoice` kind, whose own block actions answer it,
 * and the `ask_user` tool that raises a block of that kind mid-run.
 */
export const userInput = definePlugin({
  id: "user-input",
  name: "User input",
  description: "Multiple-choice questions the agent asks the user.",
  kinds: [multichoiceKind],
  tools: [askUserTool],
});

export default userInput;

export * from "./blocks/multichoice/index.ts";
export * from "./tools/ask-user/index.ts";
