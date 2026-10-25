import { Type } from "typebox";
import type { ContextMessage } from "@repo/core";
import type { PluginTool, ToolScope } from "@repo/plugins";

/** The tool's name, exported so the harness and anyone reading the graph can
 *  recognize it. */
export const SPAWN_SUBAGENT_TOOL = "spawn_subagent";

/**
 * The agents this run could hand a subagent to, listed in the tool's own
 * description.
 *
 * The roster belongs here rather than in the system prompt because it is an
 * argument's options: the model chooses `agent` while writing this call, and
 * a name it was told under some other heading is one more thing to connect.
 * It cannot be a constant in this file either — the shelves are the run's
 * working directory's, so the list is built on each mount from the same scan
 * `@agents:` completes against. Each line is the agent's own `DESCRIPTION.md`,
 * which is what a person picks it by, so a model and a person choose from the
 * same words.
 */
function agentRoster(agents: ToolScope["agents"]): string[] {
  if (agents.length === 0) {
    return [
      "This project has no Weaver agents installed, so there is none to name: leave `agent` out and the subagent runs as this agent.",
    ];
  }
  return [
    "The `agent` values available to this call, each followed by its own DESCRIPTION.md. Naming one mounts that agent's instructions, tools and skills on the nested run:",
    ...agents.map((agent) =>
      agent.description
        ? `- \`${agent.name}\`: ${agent.description.replace(/\n/g, "\n  ")}`
        : `- \`${agent.name}\` (no description)`,
    ),
  ];
}

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
 *
 * The description pushes the caller toward subtasks and toward pointing
 * rather than reporting, because only the final message comes back: a
 * subagent handed the whole task returns the answer the caller was going to
 * write anyway, so the same text is generated, carried and read twice — once
 * as this tool's result and again in whatever the caller says. A subagent
 * asked where something is returns a few hundred bytes the caller acts on,
 * and the deliverable never leaves the run the person is reading.
 */
export const spawnSubagentTool: PluginTool = {
  name: SPAWN_SUBAGENT_TOOL,
  label: "Spawn subagent",
  description: (scope) => [
    "Run a subagent — another agent like you, same model, same tools — and get back only what it finally answers. Everything else it does, its reasoning and every tool call and result included, stays in a transcript nested under this call's block: a record for the person reading the graph, not context for you.",
    "Hand off a subtask, never the task itself. The ask is yours to answer, so what leaves this run is a piece of the work — the search, the survey, the ruling out — and the answer is written here, by you. A subagent given the whole job returns text you can only repeat to whoever asked, which charges them twice for the same paragraph and shows it to them twice.",
    'Aim it at where things are, not at what is there: "where is X handled, which files does it pass through, which of these three places owns the behavior, is this name used anywhere" comes back as paths and line ranges you then open yourself. Asking it to read everything and explain is asking for your answer. A pointer costs a handful of tokens and leaves the reading — and the writing — where the ask lives.',
    "The orienting work is what pays to hand off: locating a symbol, settling which candidate owns a behavior, checking whether something is used at all, mapping how a call gets from entry point to effect, naming the files a change will touch. The material behind the map stays in its branch; the map is a few lines.",
    "Write `messages` as the subagent's whole context and write it terse: no greeting, no restating of the task you are about to give it, no explaining why the work matters, no padding to be polite. What to do, in the imperative, then only the material it needs — it has no memory of this conversation and cannot see the graph above you. `user` is what to do, `assistant` a draft to continue from, `developer` reference material (a file, a spec, background facts). End on a `user` turn stating exactly what to return.",
    'Demand a terse answer, and say what must be in it. Only the final message reaches you, so it has to carry what you will actually use — paths with line numbers, symbol names, the call chain, the three files to open — in the fewest tokens that do: fragments, one item per line, no headings, transitions, or closing summary, no narration of what it read or ruled out, and nothing pointing at its own working with "as shown above" or "the file I read". It is read by a model that will go and look, not by a person: a line saying where the thing is not is a good answer, a report is a bad one.',
    "Independent calls go in one batch: several subagents run at the same time, each in its own branch, so the same question asked of three files is three calls, not three rounds.",
    "`agent` names a Weaver agent to run the subagent as — a different instruction set, tool list and skills, listed at the end of this description. Leave it out and it runs as the agent this run is invoked as. Name one when the question is in that agent's specialty — where it would start, how it would go about something: it must still be told everything it needs, since its own instructions are the only thing it inherits besides what you write.",
    ...agentRoster(scope.agents),
  ],
  parameters: Type.Object({
    messages: Type.Array(
      Type.Object({
        role: Type.Union([
          Type.Literal(ROLES[0]),
          Type.Literal(ROLES[1]),
          Type.Literal(ROLES[2]),
        ]),
        content: Type.String({
          description: "This turn's text, as terse as it can be",
        }),
      }),
      {
        description:
          "The subagent's whole context, in order and terse. Use `user` for instructions to it; ask it for a subtask, not for the whole job.",
      },
    ),
    agent: Type.Optional(
      Type.String({
        description:
          "Name of the Weaver agent to run the subagent as, from the agents listed at the end of this description. Omit to run it as the current agent.",
      }),
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
    // An empty name is a model writing the field and leaving it blank; that is
    // the same request as not naming one, and treating it as a name would look
    // up an agent called "".
    const agent =
      typeof args.agent === "string" && args.agent.trim()
        ? args.agent.trim()
        : undefined;
    // A harness with nobody to run a nested agent cannot answer this call; say
    // so plainly instead of returning text that reads as a subagent's result.
    if (!ctx.spawnAgent) {
      return {
        content:
          "no subagent can be run in this environment — do the task yourself, or say you cannot hand it off.",
        details: {},
      };
    }
    const answer = await ctx.spawnAgent(messages, agent);
    return {
      content: answer.trim()
        ? answer
        : "the subagent finished without saying anything",
      details: {},
    };
  },
};
