import { z } from "zod";

/**
 * Reasoning-effort levels a run may ask for, mirroring pi-ai's own
 * `ThinkingLevel` (`off` plus minimal/low/medium/high/xhigh/max — the
 * SDK's `PI_REASONING_LEVEL`). A blank/omitted `thinkingLevel` means "no
 * preference": the SDK picks its default.
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * The scope a nested run's event belongs to: the wire id path of the tool
 * call that spawned it, the same path its own tool and question ids are
 * namespaced by. Present on every event a subagent streams, absent on the
 * run's own, so the renderer can hang a subagent's whole transcript off the
 * block of the call that asked for it — including while another subagent
 * streams at the same time, since each event names its own scope rather than
 * relying on the order it arrived in. A further-nested run's path is prefixed
 * by each level above it (`a/b/c`), so the nearest spawner is the one the
 * whole path resolves to.
 */
const nestScope = { nest: z.string().optional() };

/** One image a turn carries beside its text: the URI the run's own process
 *  reads (http(s)://, file://, or a scheme-less path under the run's merged
 *  `WEAVER_PWD`) and the mime type the block recognized it by. */
export const contextImage = z.object({
  uri: z.string(),
  mimeType: z.string(),
});

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
  z.object({ type: z.literal("text"), text: z.string(), ...nestScope }),
  /** One incremental chunk of an assistant message while it is still being
   *  generated, in generation order. A `text` event still follows once the
   *  message is complete. Its `text` is the authoritative full message,
   *  used verbatim when no deltas arrived (a run that used no streaming) and
   *  as the streaming block's finish signal otherwise. */
  z.object({ type: z.literal("text_delta"), text: z.string(), ...nestScope }),
  /** The model's reasoning, spoken before its reply. Some providers stream
   *  it as `thinking_delta` chunks; a `thinking` event still follows once
   *  the message is complete, on the same terms as `text`/`text_delta`. */
  z.object({ type: z.literal("thinking"), text: z.string(), ...nestScope }),
  z.object({
    type: z.literal("thinking_delta"),
    text: z.string(),
    ...nestScope,
  }),
  /** A tool call started. Opens the tool block so the call shows up while
   *  it runs, and gives the `tool_delta`/`tool` events that follow an `id`
   *  to land in the same block with. `turn` is the assistant message that
   *  asked for the call, as the run names it: opaque, stored on the block, and
   *  read only when the graph is replayed for a later run — two calls that
   *  share a turn were one message's `tool_calls`, and two that do not were
   *  two messages. See `WirePart` in `@repo/core`. */
  z.object({
    type: z.literal("tool_start"),
    id: z.string(),
    name: z.string(),
    args: z.string(),
    turn: z.string().optional(),
    ...nestScope,
  }),
  /** One incremental chunk of a running tool's output, in execution order.
   *  Only tools that request streaming updates emit these, so a call may
   *  go straight from `tool_start` to `tool`. The finished call's `tool`
   *  event is still the authoritative full output. */
  z.object({
    type: z.literal("tool_delta"),
    id: z.string(),
    text: z.string(),
    ...nestScope,
  }),
  /** A finished tool call, with whatever it printed. `turn` is as on
   *  `tool_start`, and is what a call whose start was skipped still needs in
   *  order to be replayed as part of the right assistant message. */
  z.object({
    type: z.literal("tool"),
    id: z.string(),
    name: z.string(),
    args: z.string(),
    output: z.string(),
    ok: z.boolean(),
    turn: z.string().optional(),
    /** Pictures the result carried, by URI — a `read` of an image on a model
     *  that takes one. The wire sends them as a `user` turn after the result
     *  rather than inside it, and the block keeps them so that a later run
     *  can put that turn back. See `WirePart` in `@repo/core`. */
    images: z.array(contextImage).optional(),
    ...nestScope,
  }),
  /** A media block the `display_media` tool created. `data` is validated
   *  against the media kind's schema before it is sent. The run carries on
   *  from here; a block this tool showed is all there was to it. */
  z.object({
    type: z.literal("block"),
    kind: z.string(),
    label: z.string(),
    data: z.record(z.string(), z.unknown()),
    ...nestScope,
  }),
  /** A block a run has stopped on: the tool that raised it is still inside
   *  its own call, and the run cannot take another step until the person
   *  answers the block. Like `block`, the `data` was validated against the
   *  kind's schema before it was sent, so the renderer can materialize it the
   *  same way; unlike `block`, the run stays running afterwards, and `id` is
   *  what the answer travels back under (`agent:run:answer`). A `kind` that
   *  declares no `resume` is never raised this way, because nothing could ever
   *  release it. */
  z.object({
    type: z.literal("wait"),
    id: z.string(),
    kind: z.string(),
    label: z.string(),
    data: z.record(z.string(), z.unknown()),
    ...nestScope,
  }),
  /** The run failed. Nothing follows it. */
  z.object({ type: z.literal("error"), message: z.string(), ...nestScope }),
  /** The run finished cleanly. Nothing follows. */
  z.object({ type: z.literal("done"), ...nestScope }),
]);

export type AgentEvent = z.infer<typeof agentEvent>;

/** One turn of the graph context a run sends. See `ContextMessage` in
 *  `@repo/core` for how a block becomes one. */
export const contextMessage = z.object({
  role: z.enum(["user", "assistant", "developer", "tool"]),
  content: z.string(),
  /** Pictures the turn carries, for a run whose model takes them. The URI
   *  travels, never the bytes: the renderer has no filesystem, and the main
   *  process is the one that can read a file and build a data URL. Omitted
   *  when the turn has none to show. */
  images: z.array(contextImage).optional(),
  /** The calls an `assistant` turn made, for a turn that came off a wire:
   *  the provider's transcript is not prose, and replaying it as prose is
   *  what kept a run's prefix from ever matching the run before it. See
   *  `ContextToolCall` in `@repo/core`. */
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        args: z.string(),
      }),
    )
    .optional(),
  /** Which call a `tool` turn answers, matching a `toolCalls[].id` on the
   *  assistant turn before it. */
  toolCallId: z.string().optional(),
  /** The reasoning a model produced before an `assistant` turn's text, where
   *  the graph kept it. */
  reasoning: z.string().optional(),
});

/** Request body of the `agent:run:start` IPC call. */
export const agentRunRequest = z.object({
  endpoint: z.string(),
  apiKey: z.string(),
  model: z.string(),
  /** The weaver agent to invoke the run as, by its directory name: its
   *  `INSTRUCTION.md` is appended to the system prompt, its `tools/` are
   *  mounted beside the plugins' own, and its `skills/` are added to the
   *  loader's paths. The main process resolves the name against the run's
   *  own working directory — `<cwd>/.weaver/agents/<name>` first, then
   *  `~/.weaver/agents/<name>` — so it is the same shelf the renderer's
   *  `@agents:` completion offered. A name nothing holds fails the run
   *  rather than quietly falling back to the default agent. Omitted for a
   *  run invoked as no particular agent. */
  agent: z.string().optional(),
  /** The graph above the agent block, already serialized by the renderer,
   *  turn by turn. The main process has no view of the live graph, which
   *  lives in the renderer. Each message carries the role its block's kind
   *  plays: what a person wrote is a `user` turn, what an earlier run
   *  answered is an `assistant` turn, and every other block — a tool call,
   *  a file, an environment, plain text — is `developer` material. */
  context: z.array(contextMessage),
  /** The content of the block the run is anchored on. It goes on the wire
   *  as the run's own `user` turn, after everything in `context`, so the
   *  block being run is always the thing being answered. */
  prompt: z.string(),
  /** The session the graph belongs to, so something a run creates for it —
   *  the pictures an image model generates — can be written into that
   *  session's own artifacts directory (`~/.weaver/artifacts/<id>/`) and
   *  become a media block like a pasted screenshot does. Omitted by a caller
   *  with no session of its own, which then gets a shared folder of its own
   *  rather than the project directory. */
  sessionId: z.string().optional(),
  /** Which transcript this run belongs to, named by the renderer (the root
   *  block of the graph it reads). Only ever sent to OpenAI, whose prompt
   *  cache is keyed by content but routed by this: without it a long prefix
   *  can be cached on one host and asked for on another, and the turn bills
   *  in full for no visible reason. Omitted for a run with no session of its
   *  own, such as a summarization. */
  cacheKey: z.string().optional(),
  /** Pictures the anchoring block itself holds — a run started on an image
   *  block, with no text of its own but the description in `prompt`. They
   *  belong to the ask rather than to the material above it, so they ride on
   *  the run's own turn: the main process folds them into that turn's
   *  content parts when the model takes image input. Omitted when the block
   *  being run has none. */
  promptImages: z.array(contextImage).optional(),
  /** Tool names to enable for this run. Empty means every tool the harness
   *  and the loaded plugins together make available: the built-ins
   *  (`ALLOWED_TOOLS`) plus whatever `ctx.pluginTools` contributes, so a
   *  plugin's tool is offered without core naming it here. */
  tools: z.array(z.string()),
  /** The provider `shared/provider-routing.ts` detected from `endpoint`,
   *  if any, so the main process can apply that provider's own request
   *  tuning (see `providerCompat` in `main/ipc/agent.ts`). */
  providerId: z.string().optional(),
  /** What pi's own `DefaultResourceLoader` discovers for this block:
   *  extensions, `SKILL.md` files, prompt templates, themes and project
   *  context files. Each flag, when omitted, keeps the app's default (see
   *  `DISCOVERY_DEFAULTS` in `main/lib/run-agent.ts`). */
  noExtensions: z.boolean().optional(),
  noSkills: z.boolean().optional(),
  noPromptTemplates: z.boolean().optional(),
  noThemes: z.boolean().optional(),
  noContextFiles: z.boolean().optional(),
  /** That provider's saved field values, keyed by field key. */
  providerSettings: z.record(z.string(), z.string()).optional(),
  /** Reasoning effort the run asks the model for, pi-ai's levels. A level
   *  the endpoint's provider routes into its own reasoning format (see
   *  `providerTuning` in `main/lib/run-agent.ts`); omitted for a run that
   *  didn't pick one, which leaves the SDK's default in charge. */
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
  /** Cap on how many output tokens the run's model may produce, or 0 for
   *  no cap (the provider's own default). The main process registers the
   *  model with this as its `maxTokens`, which caps a plain call and an
   *  agent run alike. Omitted runs keep the app's default. */
  maxTokens: z.number().int().nonnegative().optional(),
  /**
   * The merged environment the anchoring block sees: every `environment`
   * block above it in the graph, closer ones overriding farther ones. The
   * main process runs the agent with `WEAVER_PWD` as its working directory
   * and shades the rest of the variables over the host's own for the run.
   * Omitted when the block sees no environment at all.
   */
  env: z.record(z.string(), z.string()).optional(),
  /** Treat the run as a plain LLM call instead of an agent run: no session,
   *  no tools, no system prompt, no resource loading (everything the
   *  `no…` flags and `tools` above normally control). `prompt` goes
   *  straight to the model, after `context`, as the run's `user` turn. The
   *  summarization run sets this, so a `summary` block never has the agent
   *  harness around it. */
  plain: z.boolean().optional(),
});

export type AgentRunRequest = z.infer<typeof agentRunRequest>;

/** The harness's own built-in tools — the ones it ships rather than ones a
 *  plugin contributes (`ask_user`, `web_search`, the hindsight tools,
 *  `spawn_subagent`). The run engine unions this list with the names of the
 *  tools the loaded plugins actually mount, so a plugin's tool is allowed
 *  without core naming it here, and a drop-in plugin needs no change to this
 *  file. The main process runs commands as whoever started the app, so this
 *  is also the default when a block names no tools at all. */
export const ALLOWED_TOOLS = [
  "read",
  "grep",
  "find",
  "bash",
  "write",
  "edit",
] as const;
