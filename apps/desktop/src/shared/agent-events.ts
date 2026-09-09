import { z } from "zod";

/**
 * What one step of an agent run looks like on the wire.
 *
 * The main process's `agent:run:start` handler emits these as
 * `agent:run:event:<runId>` IPC messages while the run is still going, and
 * the renderer turns each one into a block. The translation from the agent
 * SDK's own event stream happens main-process-side on purpose. The renderer
 * should not have to know which agent library is behind the run, and a tool
 * result's raw payload (base64 images, whole files) has no business being
 * shipped twice.
 */
export const agentEvent = z.discriminatedUnion("type", [
  /** An assistant message. The agent's own words, not a tool's output. */
  z.object({ type: z.literal("text"), text: z.string() }),
  /** One incremental chunk of an assistant message while it is still being
   *  generated, in generation order. A `text` event still follows once the
   *  message is complete. Its `text` is the authoritative full message,
   *  used verbatim when no deltas arrived (a run that used no streaming) and
   *  as the streaming block's finish signal otherwise. */
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  /** The model's reasoning, spoken before its reply. Some providers stream
   *  it as `thinking_delta` chunks; a `thinking` event still follows once
   *  the message is complete, on the same terms as `text`/`text_delta`. */
  z.object({ type: z.literal("thinking"), text: z.string() }),
  z.object({ type: z.literal("thinking_delta"), text: z.string() }),
  /** A finished tool call, with whatever it printed. */
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    args: z.string(),
    output: z.string(),
    ok: z.boolean(),
  }),
  /** The agent asking for a block of a specific kind, sent through the
   *  `display` tool. `data` is validated against that kind's schema before
   *  it is sent. */
  z.object({
    type: z.literal("block"),
    kind: z.string(),
    label: z.string(),
    data: z.record(z.string(), z.unknown()),
  }),
  /** The run failed. Nothing follows it. */
  z.object({ type: z.literal("error"), message: z.string() }),
  /** The run finished cleanly. Nothing follows. */
  z.object({ type: z.literal("done") }),
]);

export type AgentEvent = z.infer<typeof agentEvent>;

/** Request body of the `agent:run:start` IPC call. */
export const agentRunRequest = z.object({
  endpoint: z.string(),
  apiKey: z.string(),
  model: z.string(),
  /** The graph above the agent block, already flattened by the renderer.
   *  The main process has no view of the live graph, which lives in the
   *  renderer. */
  context: z.string(),
  prompt: z.string(),
  /** Built-in tool names to enable for this run. Empty means every built-in
   *  tool (see `ALLOWED_TOOLS`). */
  tools: z.array(z.string()),
  /** The provider `shared/provider-routing.ts` detected from `endpoint`,
   *  if any, so the main process can apply that provider's own request
   *  tuning (see `providerCompat` in `main/ipc/agent.ts`). */
  providerId: z.string().optional(),
  /** That provider's saved field values, keyed by field key. */
  providerSettings: z.record(z.string(), z.string()).optional(),
});

export type AgentRunRequest = z.infer<typeof agentRunRequest>;

/** Every built-in tool name a block may ask for, `bash`/`write`/`edit`
 *  included. The main process runs commands as whoever started the app, so
 *  this is also the default when a block names none. */
export const ALLOWED_TOOLS = [
  "read",
  "grep",
  "find",
  "bash",
  "write",
  "edit",
  "web_search",
] as const;
