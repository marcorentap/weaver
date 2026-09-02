import { z } from "zod";
import { defineKind, snapshotAbove, TEXT_KIND } from "@repo/core";
import { kinds } from "./kinds";
import { TOOL_KIND } from "./tool";
import { ALLOWED_TOOLS, agentEvent } from "@/lib/agent-events";

/**
 * A block that runs a tool-using agent.
 *
 * Its own state is just the ask. Everything the agent reads comes from
 * walking *up* the graph from it (`ctx.graph`, via `snapshotAbove`): its
 * ancestors' preceding siblings, down to its own preceding siblings, in
 * document order. Nothing after it — later siblings, its own prior output —
 * is ever part of that context, so a re-run never feeds its own previous
 * reply back to itself.
 *
 * Everything it produces lands as nested blocks rather than in its own
 * state, and a run has more than one kind of output: what the agent said is
 * a `text` block, each tool it called is a `tool` block, and anything it
 * chose to show — an image, a file, a metric — is a block of that kind, via
 * the `display` tool. So a finished run is a readable transcript made of the
 * same blocks a person would have written by hand, editable and re-usable as
 * context for whatever comes after it.
 */
export const AGENT_KIND = "agent";

export const agentState = z.object({
  /** Sent as the final user turn, after the graph's own context. */
  prompt: z.string(),
  /** Model id to call, e.g. "anthropic/claude-haiku-4-5". Empty defers to
   *  the caller's default (see settings). */
  model: z.string(),
  /**
   * Built-in tools this block may use, comma-separated: any of
   * `read`, `grep`, `find`, `ls`, `bash`, `write`, `edit`. Blank means the
   * read-only set. It is per-block rather than a global setting because
   * `bash` and `write` run as whoever started the server, so granting them
   * should be a decision about one agent, not about the app.
   */
  tools: z.string().default(""),
  /** Message from the last failed run, if any; cleared on success. */
  error: z.string().nullable(),
  /** Epoch ms of the last completed run, or null before the first one. */
  ranAt: z.number().nullable(),
});
export type AgentState = z.infer<typeof agentState>;

/**
 * Provider credentials a run needs, passed as the hook's JSON argument
 * rather than persisted on the block: an endpoint and API key belong to the
 * caller's settings, not to graph state a model might read back as context.
 */
export const agentRunArg = z.object({
  endpoint: z.string(),
  apiKey: z.string(),
  /** Fallback when the block's own `model` is blank — the caller's default,
   *  never an override: a model typed on a block is the more specific
   *  instruction and has to win. */
  model: z.string().optional(),
});

/** How a run's failure comes back when the route rejects it outright, before
 *  the event stream starts. */
const runRejection = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]).nullish(),
});

/** Tool names a block asked for, keeping only ones the server would accept
 *  so a typo is visible here rather than silently dropped there. */
function requestedTools(spec: string): string[] {
  return spec
    .split(",")
    .map((name) => name.trim())
    .filter((name) => (ALLOWED_TOOLS as readonly string[]).includes(name));
}

export const agentKind = defineKind({
  kind: AGENT_KIND,
  schema: agentState,
  snapshot: (state) =>
    state.error !== null
      ? `agent: ${state.error}`
      : `agent: ${state.prompt || "(no prompt)"}`,
  hooks: {
    /**
     * Runs the agent and materializes its steps as nested blocks as they
     * arrive, so a long run shows its work instead of going quiet: the
     * route streams one event per step and each becomes a block
     * immediately. Children from the previous run are cleared first, so a
     * re-run replaces its transcript rather than appending a second one.
     */
    run: async (state, ctx, arg) => {
      const opts = agentRunArg.safeParse(arg ?? {});
      if (!opts.success) {
        return { ...state, error: "invalid run argument" };
      }
      const model = state.model || opts.data.model;
      if (!opts.data.endpoint || !opts.data.apiKey || !model) {
        return {
          ...state,
          error: "missing endpoint, API key, or model — check settings",
        };
      }
      if (!state.prompt.trim()) {
        return { ...state, error: "prompt is empty" };
      }

      const context = snapshotAbove(ctx.graph, ctx.id, ctx.registry);
      try {
        const res = await fetch("/api/agent/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            endpoint: opts.data.endpoint,
            apiKey: opts.data.apiKey,
            model,
            context,
            prompt: state.prompt,
            tools: requestedTools(state.tools),
          }),
        });
        if (!res.ok || !res.body) {
          const raw = await res.text();
          const rejection = runRejection.safeParse(
            ((): unknown => {
              try {
                return JSON.parse(raw);
              } catch {
                return null;
              }
            })(),
          );
          const message = rejection.success
            ? typeof rejection.data.error === "string"
              ? rejection.data.error
              : rejection.data.error?.message
            : undefined;
          throw new Error(
            message ?? `HTTP ${res.status}: ${raw.slice(0, 200) || "(empty)"}`,
          );
        }

        ctx.clearChildren();

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        let failure: string | null = null;

        const handle = (line: string) => {
          const parsed = agentEvent.safeParse(JSON.parse(line));
          if (!parsed.success) return; // A step this build does not know.
          const event = parsed.data;
          if (event.type === "text") {
            ctx.addBlock(TEXT_KIND, { text: event.text }, "assistant");
          } else if (event.type === "tool") {
            ctx.addBlock(
              TOOL_KIND,
              {
                name: event.name,
                args: event.args,
                output: event.output,
                ok: event.ok,
              },
              event.name,
            );
          } else if (event.type === "block") {
            // The server validated this against the kind's schema already;
            // parsing again keeps a stale client from writing state its own
            // registry would reject.
            const kind = kinds[event.kind];
            if (!kind) return;
            try {
              kind.parse(event.data);
            } catch {
              return;
            }
            ctx.addBlock(event.kind, event.data, event.label);
          } else if (event.type === "error") {
            failure = event.message;
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          // Events are newline-delimited, and a chunk boundary lands
          // anywhere: the tail is kept until its newline shows up.
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) handle(line);
          }
        }
        if (buffered.trim()) handle(buffered);

        if (failure !== null) throw new Error(failure);
        return { ...state, error: null, ranAt: Date.now() };
      } catch (error) {
        return {
          ...state,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
  defaults: { prompt: "", model: "", tools: "", error: null, ranAt: null },
});
