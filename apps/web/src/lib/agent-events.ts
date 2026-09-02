import { z } from "zod";

/**
 * What one step of an agent run looks like on the wire.
 *
 * `/api/agent/run` streams these as newline-delimited JSON while the run is
 * still going, and the browser turns each one into a block. The translation
 * from the agent SDK's own event stream happens server-side on purpose: the
 * client should not have to know which agent library is behind the route, and
 * a tool result's raw payload (base64 images, whole files) has no business
 * being shipped twice.
 */
export const agentEvent = z.discriminatedUnion("type", [
  /** An assistant message — the agent's own words, not a tool's output. */
  z.object({ type: z.literal("text"), text: z.string() }),
  /** A finished tool call, with whatever it printed. */
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    args: z.string(),
    output: z.string(),
    ok: z.boolean(),
  }),
  /** The agent asking for a block of a specific kind — the `display` tool.
   *  `data` is validated against that kind's schema before it is sent. */
  z.object({
    type: z.literal("block"),
    kind: z.string(),
    label: z.string(),
    data: z.record(z.string(), z.unknown()),
  }),
  /** The run failed. Terminal: nothing follows it. */
  z.object({ type: z.literal("error"), message: z.string() }),
  /** The run finished cleanly. Terminal. */
  z.object({ type: z.literal("done") }),
]);

export type AgentEvent = z.infer<typeof agentEvent>;

/** Request body of `/api/agent/run`. */
export const agentRunRequest = z.object({
  endpoint: z.string(),
  apiKey: z.string(),
  model: z.string(),
  /** The graph above the agent block, already flattened by the client — the
   *  server has no view of the live graph, which lives in the browser. */
  context: z.string(),
  prompt: z.string(),
  /** Built-in tool names to enable for this run. Empty means read-only. */
  tools: z.array(z.string()),
});

export type AgentRunRequest = z.infer<typeof agentRunRequest>;

/** Built-in tools a run gets when its block names none: it can look around
 *  the project but cannot change it, and cannot run commands. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** Everything a block may ask for, `bash`/`write`/`edit` included — this
 *  server runs commands as whoever started it, so granting them is a
 *  per-block decision rather than a default. */
export const ALLOWED_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "write",
  "edit",
] as const;
