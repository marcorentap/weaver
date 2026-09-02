import { z } from "zod";
import { defineKind, snapshotAbove, TEXT_KIND } from "@repo/core";

/**
 * A block that calls out to a language model. Its own state is just the ask
 * — everything the model reads comes from walking *up* the graph from it
 * (`ctx.graph`, via `snapshotAbove`): its ancestors' preceding siblings,
 * down to its own preceding siblings, in document order. Nothing after it —
 * later siblings, its own prior output — is ever part of that context, so a
 * re-run never feeds its own previous reply back to itself. Everything it
 * produces lands as a nested `text` block beneath it rather than in its own
 * state, so a run's output is inspectable and editable like any other block.
 */
export const AGENT_KIND = "agent";

export const agentState = z.object({
  /** Sent as the final user turn, after the graph's own context. */
  prompt: z.string(),
  /** Model id to call, e.g. "anthropic/claude-haiku-4-5". Empty defers to
   *  the caller's default (see settings). */
  model: z.string(),
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

/**
 * Shape of an OpenAI-completions `/chat/completions` response — the surface
 * `/api/agent` forwards to and from. `error` is deliberately loose: every
 * gateway in front of a provider words a failure its own way, and a run
 * should report what it was told rather than reject it for phrasing.
 */
const chatCompletionResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
      }),
    )
    .optional(),
  error: z
    .union([z.string(), z.object({ message: z.string() })])
    .nullish(),
});

export const agentKind = defineKind({
  kind: AGENT_KIND,
  schema: agentState,
  snapshot: (state) =>
    state.error !== null
      ? `agent: ${state.error}`
      : `agent: ${state.prompt || "(no prompt)"}`,
  hooks: {
    /** Gathers the rest of the graph as context, asks the model, and nests
     *  its reply as a fresh `text` child — replacing whatever child blocks
     *  the previous run left behind. */
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
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            endpoint: opts.data.endpoint,
            apiKey: opts.data.apiKey,
            model,
            messages: [
              { role: "system", content: context },
              { role: "user", content: state.prompt },
            ],
          }),
        });
        const raw = await res.text();
        let body: z.infer<typeof chatCompletionResponse>;
        try {
          body = chatCompletionResponse.parse(JSON.parse(raw));
        } catch {
          // Not the completions shape at all — a gateway's HTML error page,
          // a proxy's plain-text refusal. Report what came back, verbatim
          // and truncated, never a schema dump the user cannot act on.
          throw new Error(
            `HTTP ${res.status}: ${raw.slice(0, 200) || "(empty response)"}`,
          );
        }
        const failure =
          typeof body.error === "string" ? body.error : body.error?.message;
        if (failure) throw new Error(`${model}: ${failure}`);
        if (!res.ok) throw new Error(`${model}: HTTP ${res.status}`);
        const reply = body.choices?.[0]?.message.content;
        if (!reply) throw new Error(`${model}: empty reply`);

        ctx.clearChildren();
        ctx.addBlock(TEXT_KIND, { text: reply }, "reply");
        return { ...state, error: null, ranAt: Date.now() };
      } catch (error) {
        return {
          ...state,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
  defaults: { prompt: "", model: "", error: null, ranAt: null },
});
