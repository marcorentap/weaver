import { Type } from "typebox";
import type { PluginTool } from "@repo/plugins";
import { connectHindsight, resolveBank, toError } from "../../hindsight.ts";

/**
 * Store a memory in the bank. The agent reaches for this to persist facts
 * it wants to remember across runs: user preferences, decisions, project
 * context, events. Standalone facts work best — one item per fact, phrased
 * as a statement ("Alice works at Google"), not an instruction.
 */
export const retainTool: PluginTool = {
  name: "hindsight_retain",
  label: "Hindsight: retain memory",
  description:
    "Store a fact or event in the Hindsight memory bank so later runs can recall it. Use it to save preferences, decisions, or anything about the user or project worth remembering; store standalone facts ('Alice works at Google'), not questions or instructions.",
  parameters: Type.Object({
    content: Type.String({
      description:
        "The fact or event to remember, as a standalone statement.",
    }),
    bank: Type.Optional(
      Type.String({
        description: "Memory bank to store into. Defaults to the bank configured in Settings.",
      }),
    ),
    context: Type.Optional(
      Type.String({
        description: "Where this fact came from, e.g. '4, 2024 project review'.",
      }),
    ),
    timestamp: Type.Optional(
      Type.String({
        description: "ISO 8601 time the fact applies to, e.g. 2024-01-15T10:30:00Z. Omit for now.",
      }),
    ),
    tags: Type.Optional(
      Type.Array(Type.String({ description: "A tag" }), {
        description: "Tags to scope visibility; recall can filter on them.",
      }),
    ),
  }) as unknown as Record<string, unknown>,
  execute: async (args, ctx) => {
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) {
      throw new Error("hindsight_retain needs `content`: the fact to store");
    }
    const { client, defaultBank } = connectHindsight(ctx);
    const bank = resolveBank(args.bank, { client, defaultBank });
    const context = typeof args.context === "string" ? args.context : undefined;
    const timestamp = typeof args.timestamp === "string" ? args.timestamp : undefined;
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : undefined;

    let stored;
    try {
      stored = await client.retain(bank, content, {
        ...(context ? { context } : {}),
        ...(timestamp ? { timestamp } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
      });
    } catch (error) {
      throw toError(error);
    }
    if (!stored.success) {
      throw new Error(`Hindsight refused the retain (${stored.bank_id})`);
    }
    const items = stored.items_count ?? 1;
    return {
      content: `Stored ${items} item${items === 1 ? "" : "s"} in memory bank "${stored.bank_id}".${
        timestamp ? " Backdated to " + timestamp + "." : ""
      }`,
      details: {
        bank: stored.bank_id,
        itemsCount: items,
        async: stored.async,
      },
    };
  },
};