import { Type } from "typebox";
import type { PluginTool } from "@repo/plugins";
import { connectHindsight, resolveBank, toError } from "../../hindsight.ts";

/**
 * Queue a memory for storage in the bank. The agent reaches for this to
 * persist facts it wants to remember across runs: user preferences,
 * decisions, project context, events. Standalone facts work best — one
 * item per fact, phrased as a statement ("Alice works at Google"), not an
 * instruction. Fire-and-forget: the server acknowledges the queue and the
 * tool returns without waiting for extraction/indexing to finish.
 */
export const retainTool: PluginTool = {
  name: "hindsight_retain",
  label: "Hindsight: retain memory",
  description:
    "Queue a fact or event for storage in the Hindsight memory bank so later runs can recall it. Use it to save preferences, decisions, or anything about the user or project worth remembering; store standalone facts ('Alice works at Google'), not questions or instructions. Retains asynchronously: the tool returns as soon as the server accepts the item — it does not wait for processing to complete.",
  parameters: Type.Object({
    content: Type.String({
      description:
        "The fact or event to remember, as a standalone statement.",
    }),
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
    const bank = resolveBank({ client, defaultBank });
    const context = typeof args.context === "string" ? args.context : undefined;
    const timestamp = typeof args.timestamp === "string" ? args.timestamp : undefined;
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : undefined;

    let stored;
    try {
      stored = await client.retain(bank, content, {
        async: true,
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
      content: `Queued ${items} item${items === 1 ? "" : "s"} in memory bank "${stored.bank_id}"; stored in the background.${
        timestamp ? " Backdated to " + timestamp + "." : ""
      }`,
      details: {
        bank: stored.bank_id,
        itemsCount: items,
        async: stored.async,
        operationId: stored.operation_id,
      },
    };
  },
};