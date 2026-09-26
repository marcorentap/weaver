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
    "Ask the user a multiple-choice question and wait for their answer. Adds a `multichoice` block right after the current block — a prompt, the options you supply, plus the built-in Other option and an additional-note input the user always has — and the run stops there until they submit it. Their answer comes back as this tool's result, so you continue from it in the same run, having actually been told.",
    "Since this blocks, ask when the answer changes what you do next and you cannot find it out yourself: which of two readings of the task is meant, a choice between approaches, a value only they know. Do not ask what you can check — read the file, run the command, look it up. Do not ask to confirm something they already told you, and do not ask a question you could answer by picking a sensible default and saying which one you picked.",
    "A question raised this way also lands in the graph as a block, so a later run above it reads the question as an assistant turn and the answer as a user turn. On a run that cannot stop for an answer — a harness with no user attached, like a remote instance — this adds the same block but does not wait, and tells you so: in that case say what you would have asked rather than assuming an answer.",
    "When a multichoice block above you in the graph reaches you, it arrives as turns rather than as text: the question as an assistant turn, and — once the user has answered — their answer as a user turn, with one bullet per picked option: `- option`, `- Other: <text>` when Other was picked (with whatever they typed into it), and `- Note: <text>` for their additional note. Nothing marks the answer as an answer, because the role already says the user is the one speaking. A question with no user turn after it has not been answered yet, so read the options it lists as suggestions, not as an answer.",
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
    const question = {
      prompt,
      options,
      selected: [],
      other: "",
      note: "",
      answered: false,
    };
    // The ordinary path: the block lands and this call stays inside `execute`
    // until the user submits an answer to it, which the harness passes back
    // here. `wait` is what does the materializing, so the block is not added
    // twice.
    if (ctx.wait) {
      const answer = await ctx.wait(MULTICHOICE_KIND, question, label);
      return {
        content:
          answer === null
            ? `the question "${prompt}" was not answered — nobody was left to answer it, ` +
              "or it was discarded. Say what you need from the user instead of " +
              "assuming an answer, and do not raise the same question again."
            : `the user answered:\n${answer}`,
        details: { kind: MULTICHOICE_KIND, answered: answer !== null },
      };
    }
    // A caller that can put a block in the graph but cannot hold a run for it
    // (a bare tool host). The question is still worth raising; nothing here
    // waits on it, so say that plainly rather than leaving the model to think
    // the silence is an answer.
    ctx.addBlock(MULTICHOICE_KIND, question, label);
    return {
      content:
        `added a multichoice block asking: ${prompt}. Nothing here can wait for ` +
        "an answer, so tell the user the question is in the graph — re-running " +
        "inference on that block is what picks the answer up.",
      details: { kind: MULTICHOICE_KIND, answered: false },
    };
  },
};
