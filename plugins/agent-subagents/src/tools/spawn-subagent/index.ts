import { Type } from "typebox";
import type { ContextMessage } from "@repo/core";
import type { PluginTool } from "@repo/plugins";

/** The tool's name, exported so the harness and anyone reading the graph can
 *  recognize it. */
export const SPAWN_SUBAGENT_TOOL = "spawn_subagent";

/** The conversational roles a subagent's context may hold. The same three the
 *  graph itself speaks in (see `ContextMessage`), so a spawning agent can
 *  hand over material with the roles it already has. */
const ROLES = ["user", "assistant", "developer"] as const;

/**
 * Spawn a subagent: a run of the same agent on a context supplied by the
 * caller, whose transcript lands nested under this call's own block. The
 * subagent inherits the spawning run's inference configuration and
 * environment, so it answers with the same model the caller is on, and it is
 * a full agent run, which means it can spawn a subagent of its own.
 *
 * The tool only names the messages; the harness owns running the nested
 * agent, and a harness that cannot run one leaves `ctx.spawnAgent` off, which
 * this tool reports rather than pretending a subagent answered.
 */
export const spawnSubagentTool: PluginTool = {
  name: SPAWN_SUBAGENT_TOOL,
  label: "Spawn subagent",
  description: [
    "Run a subagent — another agent like you, on the same model and with the same tools — and get back what it finally answers. Use it to hand off a self-contained task you would otherwise do in this conversation: research that would fill your context with material you do not need afterwards, a side investigation, or work that can run on its own wording without the history around you. The subagent's whole transcript — every turn of its working, its tool calls and what they returned included — lands nested under this call's block. That transcript is a record for the person reading the graph, not for you.",
    'Only its final message reaches you. Its reasoning, the tools it called, and everything it wrote before signing off stay in that nested branch, and no later run of yours reads them either. So your instruction has to say what you need back: tell the subagent its final answer must stand on its own — carrying the facts, the file paths, the numbers, the code, the quotes — and that it must not point at its own working with "as shown above" or "the file I read", because you cannot see any of it. A subagent asked only to "investigate X" can answer "X is fine, I checked" and leave you with nothing to use.',
    "`messages` is the subagent's entire context, sent as the turns it already holds, so write it as the conversation the subagent should see. Use the `user` role for instructions to the subagent — what you want it to do — and give it everything it needs, because it starts with no memory of this conversation: your instruction has to stand on its own. Use `assistant` for something you want it to read as its own earlier reply (say, a first draft to continue from), and `developer` for reference material it reads but is not continuing (a file's contents, a spec, background facts). The last thing it sees should be a `user` turn telling it what to produce, and its answer is what this call returns.",
    "Prefer a subagent for any task that breaks into isolated subtasks. Everything a subagent reads, searches, and discards stays in its own branch, and only its final answer enters your context, so parceling a large job out across subagents is how you keep your own context from filling with material you will not need once the answer is in hand. Reach for this when the work is substantial and its parts do not need to see each other or the conversation you are in: reading a whole module, tracing a call through many files, comparing several approaches.",
    "Several calls in one batch run at the same time, each in its own branch, so when the work is genuinely independent — the same question asked of different files, several modules read at once, a few approaches compared — issue the calls together rather than one after another, and wait for the whole batch.",
    "A subagent is not a replacement for doing the work yourself when the task is small or its parts depend on the conversation you are in: it cannot see the graph, only the messages you send it, and a hand-off costs a whole run. A subtask small enough to finish in a couple of tool calls is cheaper done here; do the small, connected things yourself.",
    "Say what you learned from the answer in your own reply, so the result stays in the conversation rather than only in the nested branch.",
  ].join("\n"),
  parameters: Type.Object({
    messages: Type.Array(
      Type.Object({
        role: Type.Union([
          Type.Literal(ROLES[0]),
          Type.Literal(ROLES[1]),
          Type.Literal(ROLES[2]),
        ]),
        content: Type.String({
          description: "The text of this turn",
        }),
      }),
      {
        description:
          "The subagent's whole context, in order. Use `user` for instructions to it.",
      },
    ),
  }) as unknown as Record<string, unknown>,
  execute: async (args, ctx) => {
    const raw = Array.isArray(args.messages) ? args.messages : [];
    const messages: ContextMessage[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const role = record.role;
      const content = record.content;
      if (
        typeof content !== "string" ||
        (role !== "user" && role !== "assistant" && role !== "developer")
      ) {
        throw new Error(
          "spawn_subagent needs each message to have a `role` of user, assistant, or developer and a string `content`",
        );
      }
      messages.push({ role, content });
    }
    if (messages.length === 0) {
      throw new Error(
        "spawn_subagent needs at least one message describing what the subagent should do",
      );
    }
    // A harness with nobody to run a nested agent cannot answer this call; say
    // so plainly instead of returning text that reads as a subagent's result.
    if (!ctx.spawnAgent) {
      return {
        content:
          "no subagent can be run in this environment — do the task yourself, or say you cannot hand it off.",
        details: {},
      };
    }
    const answer = await ctx.spawnAgent(messages);
    return {
      content: answer.trim()
        ? answer
        : "the subagent finished without saying anything",
      details: {},
    };
  },
};
