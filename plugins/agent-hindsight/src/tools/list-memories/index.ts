import { Type } from "typebox";
import type { PluginTool } from "@repo/plugins";
import { connectHindsight, resolveBank, toError } from "../../hindsight.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Render one memory unit row. The list endpoint's item shape is loose, so
 *  read the fields we know and fall back to the raw record for anything
 *  unexpected instead of guessing at a schema. */
function formatMemoryUnit(item: Record<string, unknown>): string {
  const id = textOf(item.id) ?? "?";
  const content = textOf(item.content) ?? textOf(item.text) ?? JSON.stringify(item);
  const type = textOf(item.type);
  const when = textOf(item.timestamp) ?? textOf(item.occurred_at) ?? textOf(item.mentioned_at);
  const line = `- [${type ?? "fact"}] ${content}`;
  return when ? `${line} (${when})\n    id ${id}` : `${line}\n    id ${id}`;
}

/**
 * Page through the raw memories in a bank. Unlike `hindsight_recall` this
 * returns stored items as-is, without retrieval ranking — the tool for
 * inspecting what the bank actually holds, not for answering from it.
 */
export const listMemoriesTool: PluginTool = {
  name: "hindsight_list",
  label: "Hindsight: list memories",
  description:
    "List the memories stored in a Hindsight bank as they are saved, with pagination and optional text/type filters. Use it to inspect or audit what the bank holds, not to answer a question — `hindsight_recall` is the search tool.",
  parameters: Type.Object({
    bank: Type.Optional(
      Type.String({
        description: "Memory bank to list from. Defaults to the bank configured in Settings.",
      }),
    ),
    q: Type.Optional(
      Type.String({
        description: "Optional text filter; returns memories whose content matches.",
      }),
    ),
    type: Type.Optional(
      Type.Union([Type.Literal("world"), Type.Literal("experience"), Type.Literal("observation")], {
        description: "Only list memories of this fact type.",
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: `Max memories to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
      }),
    ),
    offset: Type.Optional(
      Type.Number({ description: "How many memories to skip (for paging)." }),
    ),
  }) as unknown as Record<string, unknown>,
  execute: async (args, ctx) => {
    const { client, defaultBank } = connectHindsight(ctx);
    const bank = resolveBank(args.bank, { client, defaultBank });
    const q = typeof args.q === "string" && args.q.trim() ? args.q.trim() : undefined;
    const type =
      typeof args.type === "string" ? (args.type as "world" | "experience" | "observation") : undefined;
    const limit =
      typeof args.limit === "number"
        ? Math.min(Math.max(1, Math.trunc(args.limit)), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const offset =
      typeof args.offset === "number" && Number.isFinite(args.offset) && args.offset >= 0
        ? Math.trunc(args.offset)
        : undefined;

    let response;
    try {
      response = await client.listMemories(bank, {
        ...(q ? { q } : {}),
        ...(type ? { type } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
    } catch (error) {
      throw toError(error);
    }

    const items = Array.isArray(response.items)
      ? response.items.filter((item) => typeof item === "object" && item !== null)
      : [];
    const total = typeof response.total === "number" ? response.total : items.length;
    if (items.length === 0) {
      return {
        content: `No memories in memory bank "${bank}".`,
        details: { bank, total },
      };
    }
    const heading = `${items.length} of ${total} memories in memory bank "${bank}"${
      offset ? `, skipping the first ${offset}` : ""
    }`;
    return {
      content: [heading, ...items.map((item) => formatMemoryUnit(item as Record<string, unknown>))].join(
        "\n",
      ),
      details: { bank, total, count: items.length },
    };
  },
};