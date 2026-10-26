import { Type } from "typebox";
import type { PluginTool } from "@repo/plugins";
import { recallResponseToPromptString } from "@vectorize-io/hindsight-client";
import { connectHindsight, resolveBank, toError } from "../../hindsight.ts";

const FACT_TYPES = ["world", "experience", "observation"] as const;

/** The SDK's budget values: how much evidence recall spends composing. */
const BUDGETS = ["low", "mid", "high"] as const;

/**
 * Recall runs on nearly every run, before the agent has decided whether it
 * needs memory at all, and its facts come back with their duplicates intact —
 * one fact retained five times reads as five results. What bounds the answer
 * is therefore how many results come back, not how many tokens: the server
 * returns them ranked, so the first few carry what the query was asking about
 * and the tail is repetition its ranking could not separate. Both defaults are
 * floors a caller can lift, and the token cap stays underneath as the backstop
 * for the case where a handful of results are each very long.
 */
const DEFAULT_LIMIT = 5;
const DEFAULT_MAX_TOKENS = 1200;

/**
 * Search the bank's memories with a natural-language query. Returns the
 * matching facts (and the entities they mention) formatted for the model to
 * read straight off, via the SDK's own recall-to-prompt formatter.
 */
export const recallTool: PluginTool = {
  name: "hindsight_recall",
  label: "Hindsight: recall memories",
  description:
    "Search the Hindsight memory bank with a natural-language query and return the most relevant stored facts. Use it whenever a run needs information from before — earlier conversations, user preferences, project history — before asking the user or guessing.",
  parameters: Type.Object({
    query: Type.String({
      description:
        "What to find, phrased as a question or a description of the missing information.",
    }),
    types: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("world"),
          Type.Literal("experience"),
          Type.Literal("observation"),
        ]),
        {
          description:
            "Fact types to include: 'world' facts, 'experience' events, 'observation' synthesized perspectives. Defaults to all.",
        },
      ),
    ),
    budget: Type.Optional(
      Type.Union(
        [Type.Literal("low"), Type.Literal("mid"), Type.Literal("high")],
        {
          description:
            "How much effort to spend composing results: 'low', 'mid', or 'high'.",
        },
      ),
    ),
    limit: Type.Optional(
      Type.Number({
        description: `How many of the most relevant results to return. Defaults to ${DEFAULT_LIMIT}. Raise it when a question needs several distinct facts and the default came back short; lower it for a narrow lookup.`,
      }),
    ),
    maxTokens: Type.Optional(
      Type.Number({
        description: `Cap on how many total output tokens the results may use. Defaults to ${DEFAULT_MAX_TOKENS}; raise it only when the default cut off a fact you know is there.`,
      }),
    ),
    preferObservations: Type.Optional(
      Type.Boolean({
        description:
          "Drop raw facts an observation was consolidated from, so synthesized observations supersede their sources.",
      }),
    ),
  }) as unknown as Record<string, unknown>,
  execute: async (args, ctx) => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      throw new Error(
        "hindsight_recall needs `query`: what to search the bank for",
      );
    }
    const { client, defaultBank } = connectHindsight(ctx);
    const bank = resolveBank({ client, defaultBank });

    const types =
      Array.isArray(args.types) &&
      args.types.every((t) => FACT_TYPES.includes(t as never))
        ? (args.types as (typeof FACT_TYPES)[number][])
        : undefined;
    const budget =
      typeof args.budget === "string" &&
      (BUDGETS as readonly string[]).includes(args.budget)
        ? (args.budget as (typeof BUDGETS)[number])
        : undefined;
    const maxTokens =
      typeof args.maxTokens === "number" && args.maxTokens > 0
        ? args.maxTokens
        : DEFAULT_MAX_TOKENS;
    const limit =
      typeof args.limit === "number" && args.limit > 0
        ? Math.floor(args.limit)
        : DEFAULT_LIMIT;
    const preferObservations =
      typeof args.preferObservations === "boolean"
        ? args.preferObservations
        : undefined;

    let response;
    try {
      response = await client.recall(bank, query, {
        ...(types ? { types } : {}),
        ...(budget ? { budget } : {}),
        maxTokens,
        ...(preferObservations !== undefined ? { preferObservations } : {}),
      });
    } catch (error) {
      throw toError(error);
    }
    if (response.results.length === 0) {
      return {
        content: `No memories match "${query}" in memory bank "${bank}".`,
        details: { bank, results: 0 },
      };
    }
    // The SDK's formatter takes the whole response, so the cap is applied here
    // rather than upstream: results arrive ranked, and the ones left out are
    // the tail of that ranking.
    const kept = response.results.slice(0, limit);
    return {
      content: recallResponseToPromptString({ ...response, results: kept }),
      details: {
        bank,
        results: kept.length,
        ...(kept.length < response.results.length
          ? { omitted: response.results.length - kept.length }
          : {}),
      },
    };
  },
};
