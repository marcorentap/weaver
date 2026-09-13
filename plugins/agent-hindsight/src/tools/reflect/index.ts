import { Type } from "typebox";
import type { PluginTool } from "@repo/plugins";
import { connectHindsight, resolveBank, toError } from "../../hindsight.ts";

const BUDGETS = ["low", "mid", "high"] as const;

/**
 * Reflect answers a query the way the bank's personality would: it pulls
 * the relevant memories and mental models, then writes a response grounded
 * in them. This is the "answer from memory" operation, as opposed to
 * `hindsight_recall`, which returns raw facts.
 */
export const reflectTool: PluginTool = {
  name: "hindsight_reflect",
  label: "Hindsight: reflect",
  description:
    "Ask the Hindsight memory bank to answer a question about what it remembers — grounded in stored memories and the bank's model of the user. Use it when facts alone are not enough and you want the bank's synthesized answer (preferences dug out of observations, an opinion formed from what it knows).",
  parameters: Type.Object({
    query: Type.String({
      description: "The question to answer from the bank's memories.",
    }),
    bank: Type.Optional(
      Type.String({
        description: "Memory bank to reflect over. Defaults to the bank configured in Settings.",
      }),
    ),
    context: Type.Optional(
      Type.String({
        description:
              "A hint about why this is being asked now, e.g. 'preparing for a meeting' — shapes how the answer is framed.",
      }),
    ),
    budget: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("mid"), Type.Literal("high")], {
        description: "How much effort to spend composing: 'low', 'mid', or 'high'.",
      }),
    ),
  }) as unknown as Record<string, unknown>,
  execute: async (args, ctx) => {
    const query = typeof args.question === "string" ? args.question.trim() : "";
    if (!query) {
      throw new Error("hindsight_reflect needs `question`: what to ask the bank");
    }
    const { client, defaultBank } = connectHindsight(ctx);
    const bank = resolveBank(args.bank, { client, defaultBank });
    const context = typeof args.context === "string" ? args.context : undefined;
    const budget =
      typeof args.budget === "string" && (BUDGETS as readonly string[]).includes(args.budget)
        ? (args.budget as (typeof BUDGETS)[number])
        : undefined;

    let answer;
    try {
      answer = await client.reflect(bank, query, {
        ...(context ? { context } : {}),
        ...(budget ? { budget } : {}),
      });
    } catch (error) {
      throw toError(error);
    }
    return {
      content: answer.text,
      details: { bank },
    };
  },
};