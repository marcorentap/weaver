import { Type } from "typebox";
import type { PluginTool } from "@repo/plugins";
import { MULTICHOICE_KIND } from "../../blocks/multichoice/index.ts";

/** The tool's name, exported so the harness can recognize it (a successful
 *  call records only its multichoice block, not a tool block too). */
export const ASK_USER_TOOL = "ask_user";

export const askUserTool: PluginTool = {
  name: ASK_USER_TOOL,
  label: "Ask the user",
  description: [
    "Raise a multiple-choice question the user answers inside the graph. Adds a `multichoice` block right after the current block: a prompt, the options you supply, plus the built-in Other option and an additional-note input the user always has.",
    "Nothing here waits for or continues with the answer: the run ends, the user answers the block whenever they like, and re-running inference on that block (or on anything below it) reads the answer as context. Re-run on the block itself and the question arrives as your own assistant turn with the answer as the user turn after it, so you continue from their answer rather than from the question.",
    "When a multichoice block above you in the graph reaches you, it arrives as turns rather than as text: the question as an assistant turn, and — once the user has answered — their answer as a user turn, with one bullet per picked option: `- option`, `- Other: <text>` when Other was picked (with whatever they typed into it), and `- Note: <text>` for their additional note. Nothing marks the answer as an answer, because the role already says the user is the one speaking. A question with no user turn after it has not been answered yet, so read the options it lists as suggestions, not as an answer.",
    "Prefer asking whenever asking is cheaper than guessing: if you are confused or stuck — running out of direction, going in circles, unsure which of several readings of the task is right — ask a clarification here instead of spending more turns burning tool calls on the wrong guess.",
    "Do not ask the user to do something you can check yourself — check first, ask only what only they know.",
  ].join("\n"),
  parameters: Type.Object({
    prompt: Type.String({
      description: "The question to ask the user, phrased as a concrete choice",
    }),
    options: Type.Optional(
      Type.Array(
        Type.String({
          description: "A suggested choice, one per element",
        }),
        {
          description:
            "Suggested choices; the Other option is always added on top",
        },
      ),
    ),
  }) as unknown as Record<string, unknown>,
  execute: async (args, ctx) => {
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) {
      throw new Error("ask_user needs a prompt describing the question");
    }
    // Deduplicate and drop blank strings, so a careless call still lands as a
    // clean block instead of an oddly empty option.
    const raw = Array.isArray(args.options) ? args.options : [];
    const options = [
      ...new Set(
        raw
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    ];
    if (!ctx.addBlock) {
      return {
        content:
          "no graph to raise a question into in this environment — tell the user you cannot ask them.",
        details: { kind: MULTICHOICE_KIND },
      };
    }
    // A fixed, short name for the block — never the question, which can be
    // long and read as body text in the graph.
    const label = "ask user";
    ctx.addBlock(
      MULTICHOICE_KIND,
      { prompt, options, selected: [], other: "", note: "" },
      label,
    );
    return {
      content:
        `added a multichoice block asking: ${prompt}. ` +
        "The user answers it in the block. Nothing continues from here on their answer; re-run inference on that block to pick it up.",
      details: { kind: MULTICHOICE_KIND },
    };
  },
};
