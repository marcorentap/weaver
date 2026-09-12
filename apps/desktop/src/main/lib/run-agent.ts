import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import { z } from "zod";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { OpenRouterRouting } from "@earendil-works/pi-ai";
import { WEAVER_PWD, type KindRegistry } from "@repo/core";
import type { PluginTool } from "@repo/plugins";
import { MEDIA_KIND, parseMediaUri } from "@plugins/rich-media";
import {
  ALLOWED_TOOLS,
  agentRunRequest,
  type AgentEvent,
  type AgentRunRequest,
} from "../../shared/agent-events.js";
import { readSource } from "./read-source.js";
import { writeSource } from "./write-source.js";
import { editSource } from "./edit-source.js";
import { schemaMessage } from "./schema-error.js";

/** Config directory handed to the agent. Sessions are in-memory and every
 *  discovery pass is disabled, so nothing is actually read from it. */
const AGENT_DIR = "/tmp/weaver-agent";

/**
 * Markdown image syntax naming a `file://` URI: `![alt](file://…)`. The
 * model can point `display_media` at a URI, or just write it inline in its
 * own reply, and either way it is a URI this live run just asserted, so
 * both get the same "trust it until the next autosave" treatment as
 * `display_media` (see pending-media.ts). Without this, an inline image the
 * model writes instead of calling the tool 403s at the `weaver-media://`
 * protocol handler, since it is neither store-referenced nor inside the
 * project, and silently fails to render. A plain link is not covered: it
 * opens through `shell.openExternal`, never through `weaver-media://`, so
 * it never hits that check.
 */
const INLINE_MEDIA_IMAGE = /!\[[^\]]*\]\(\s*(file:\/\/[^\s)]+)\)/g;

/** On a remote instance, this is the machine where the connection (and the
 *  block that references the URI) lives, so there is nothing to register:
 *  the emitted block's data travels as data, and serving the URI's bytes is
 *  that machine's problem. */
function registerInlineMedia(
  text: string,
  registerPendingMedia?: ((uri: string) => void) | undefined,
): void {
  if (!registerPendingMedia) return;
  for (const match of text.matchAll(INLINE_MEDIA_IMAGE)) {
    const uri = match[1];
    if (uri && parseMediaUri(uri)) registerPendingMedia(uri);
  }
}

/**
 * Everything a run needs that differs between the local app and a remote
 * instance. The runner itself (session, tools, prompt, event mapping) is
 * agent-SDK and filesystem code with no Electron in it, so the desktop app
 * and the remote server can drop in different bindings for the same run:
 * where events go, what the project root is, which plugins are loaded, what
 * a plugin's settings are, how a run can be aborted.
 */
export type AgentRunContext = {
  /** Base directory relative `WEAVER_PWD` values resolve against and, when
   *  a block sets none, the directory the agent starts in. */
  root: string;
  /** Every block kind the agent's tools validate against. */
  kinds: KindRegistry;
  /** Every agent tool the loaded plugins contribute. */
  pluginTools: PluginTool[];
  /** One plugin's setting value, `undefined` when unset. */
  getSetting: (pluginId: string, key: string) => string | undefined;
  /** Called once a session exists so the caller can abort it (IPC cancel,
   *  a remote client disconnecting). */
  onSession?: (abort: () => void) => void;
  /** Called for URIs a live run asserts it is about to show, so the local
   *  media protocol serves them before their block persists. The remote
   *  server passes nothing. */
  registerPendingMedia?: (uri: string) => void;
};

/**
 * Replaces the SDK's own system prompt entirely (see `resourceLoader`
 * below), so a weaver block's instructions are exactly what's here plus the
 * graph above it. The parts of pi's default prompt that still apply when
 * running as one block in a weaver graph — the expert-assistant framing,
 * "be concise", "show file paths clearly", the pointer to pi's docs — are
 * extracted into this file; the rest (CLI-agent framing, SDK-built tool
 * list fine for the API's own tool array) is dropped. Kept as its
 * own committed file rather than an inline string so it reads and diffs like
 * prose, not code.
 *
 * Bundled main-process code is a single flattened `out/main/index.js`, so
 * `import.meta.dirname` at run time is `out/main`, the same directory
 * `vite-plugin-static-copy` (see electron.vite.config.ts) copies
 * `agent/system-prompt.md` into. The remote server runs inside the same
 * process as the app, so the same relative read resolves there too.
 */
const WEAVER_SYSTEM_PROMPT = readFileSync(
  join(import.meta.dirname, "agent/system-prompt.md"),
  "utf8",
);

/**
 * The agent SDK types its event payloads as `any`, so everything crossing
 * that boundary is parsed rather than asserted. A shape change upstream
 * should degrade to an empty string, not to a wrong read of a wrong field.
 */
const contentParts = z.object({
  role: z.string().optional(),
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        thinking: z.string().optional(),
        mimeType: z.string().optional(),
      }),
    )
    .optional(),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
});

/** Text of a tool result, joined. Image content is named rather than
 *  inlined because the bytes are already on disk and the browser has the
 *  path. */
function resultText(result: unknown): string {
  const parsed = contentParts.safeParse(result);
  if (!parsed.success) return "";
  return (parsed.data.content ?? [])
    .map((part) => {
      if (part.type === "text") return part.text ?? "";
      if (part.type === "image") return `[image ${part.mimeType ?? ""}]`;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Assistant prose from a finished message. `message_end` fires for the user
 * turn and for every tool result too, so the role is checked first. Without
 * that, a run echoes its own prompt back as a block and repeats each tool's
 * output twice. Tool calls become their own blocks and reasoning is read
 * separately by `messageThinking`, so only spoken text is left here.
 */
function messageText(message: unknown): string {
  const parsed = contentParts.safeParse(message);
  if (!parsed.success || parsed.data.role !== "assistant") return "";
  return (parsed.data.content ?? [])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

/** The model's reasoning from a finished message, on the same terms as
 *  `messageText`. Deltas already streamed it in during generation; this is
 *  the terminal signal for a run that streamed no `thinking_delta` at all
 *  (a non-reasoning provider, or a non-streaming one). */
function messageThinking(message: unknown): string {
  const parsed = contentParts.safeParse(message);
  if (!parsed.success || parsed.data.role !== "assistant") return "";
  return (parsed.data.content ?? [])
    .map((part) => (part.type === "thinking" ? (part.thinking ?? "") : ""))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

/** A failed turn's own message, not a thrown error: the agent SDK encodes
 *  a rejected request (bad routing, provider error, and so on) as a
 *  normal `message_end` with `stopReason: "error"` and `errorMessage` set,
 *  rather than throwing. Without reading this, that message's `content`
 *  is typically empty and the run silently produces nothing. `"aborted"`
 *  is excluded: that is Ctrl+C, not a failure. */
function messageFailure(message: unknown): string | null {
  const parsed = contentParts.safeParse(message);
  if (
    !parsed.success ||
    parsed.data.role !== "assistant" ||
    parsed.data.stopReason !== "error"
  ) {
    return null;
  }
  return parsed.data.errorMessage ?? "inference failed";
}

/** `shared/provider-routing.ts`'s "Thinking level" values, structurally
 *  matching pi-ai's `ThinkingLevel` without importing it (that type is in
 *  a transitive dependency this package doesn't declare directly). */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** Sail's completion-window values; anything else means its own default
 *  ("asap"). */
const SAIL_COMPLETION_WINDOWS = ["balanced", "flex"] as const;

/** OpenRouter's attribution: `HTTP-Referer` names this app on openrouter.ai
 *  and `X-OpenRouter-Title` sets its display name; the docs require them
 *  together (https://openrouter.ai/docs/app-attribution) and `pi-coding-agent`
 *  adds its own defaults (HTTP-Referer https://pi.dev, X-OpenRouter-Title pi,
 *  X-OpenRouter-Categories cli-agent) that our request headers override via
 *  the merge. Sent on every request to OpenRouter so usage lands under
 *  weaver's app page. */
const OPENROUTER_ATTRIBUTION = {
  "HTTP-Referer": "https://weaver.marcorentap.com",
  "X-OpenRouter-Title": "Weaver",
  "X-OpenRouter-Categories": "personal-agent",
} as const;

/** Turns the renderer's `providerId`/`providerSettings` into that
 *  provider's request tuning. OpenRouter's `only`/`sort` become the
 *  `provider` routing object; its reasoning effort needs
 *  `thinkingFormat: "openrouter"`. Sail's reasoning effort needs no
 *  compat override (pi-ai's default `reasoning_effort` already matches),
 *  but it 400s on `store: false`, which pi-ai sends unless told
 *  otherwise, so Sail always gets `supportsStore: false`. Sail's
 *  completion window becomes `metadata.completion_window` via
 *  `samplingParams`. A thinking level always marks the model
 *  reasoning-capable and sets the session's thinking level. Any other
 *  provider, or none set, is a no-op. */
function providerTuning(
  providerId: string | undefined,
  providerSettings: Record<string, string> | undefined,
): {
  compat?: {
    openRouterRouting?: OpenRouterRouting;
    thinkingFormat?: "openrouter";
    supportsStore?: boolean;
  };
  samplingParams?: Record<string, unknown>;
  reasoning: boolean;
  thinkingLevel?: (typeof THINKING_LEVELS)[number];
} {
  const thinkingRaw = providerSettings?.thinkingLevel?.trim();
  const thinkingLevel = (THINKING_LEVELS as readonly string[]).includes(
    thinkingRaw ?? "",
  )
    ? (thinkingRaw as (typeof THINKING_LEVELS)[number])
    : undefined;

  if (providerId === "openrouter") {
    const only = (providerSettings?.only ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean);
    const sort = providerSettings?.sort?.trim();
    const routing: OpenRouterRouting = {};
    if (only.length > 0) routing.only = only;
    if (sort) routing.sort = sort;
    const hasRouting = Object.keys(routing).length > 0;
    if (!hasRouting && !thinkingLevel) return { reasoning: false };
    return {
      compat: {
        ...(hasRouting ? { openRouterRouting: routing } : {}),
        ...(thinkingLevel ? { thinkingFormat: "openrouter" as const } : {}),
      },
      reasoning: Boolean(thinkingLevel),
      thinkingLevel,
    };
  }

  if (providerId === "sail") {
    const windowRaw = providerSettings?.completionWindow?.trim();
    const completionWindow = (
      SAIL_COMPLETION_WINDOWS as readonly string[]
    ).includes(windowRaw ?? "")
      ? (windowRaw as (typeof SAIL_COMPLETION_WINDOWS)[number])
      : undefined;
    return {
      compat: { supportsStore: false },
      samplingParams: completionWindow
        ? { metadata: { completion_window: completionWindow } }
        : undefined,
      reasoning: Boolean(thinkingLevel),
      thinkingLevel,
    };
  }

  return { reasoning: false };
}

/**
 * One full agent run. Validates the request, mounts the model, tools and
 * plugins, runs the session, and maps every SDK event into the app's
 * `AgentEvent` shape, emitted through `emit` until a terminal
 * (`done`/`error`) event. Caller-agnostic: the Electron IPC handler and the
 * remote server both call this, differing only in their `AgentRunContext`.
 * Resolves after the terminal event has been emitted; a run that was aborted
 * via `ctx.onSession`'s abort still resolves here.
 */
export async function runAgent(
  request: unknown,
  ctx: AgentRunContext,
  emit: (event: AgentEvent) => void,
): Promise<void> {
  let body: AgentRunRequest;
  try {
    body = agentRunRequest.parse(request);
  } catch (error) {
    emit({ type: "error", message: schemaMessage(error) });
    return;
  }

  try {
    const modelRuntime = await ModelRuntime.create({
      // Nothing on disk: the endpoint and key come from the caller's
      // settings, and a catalog refresh per run would be a wasted round
      // trip for a provider list nobody reads.
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const tuning = providerTuning(body.providerId, body.providerSettings);
    modelRuntime.registerProvider("weaver", {
      baseUrl: body.endpoint,
      apiKey: body.apiKey,
      api: "openai-completions",
      // The register config's `headers` become request headers on every
      // call (see provider-composer's `resolveCompatibilityRequestConfig`),
      // so OpenRouter sees the app attribution on each request its usage
      // panel counts. Harmless anywhere else, but only OpenRouter asks.
      ...(body.providerId === "openrouter"
        ? { headers: OPENROUTER_ATTRIBUTION }
        : {}),
      models: [
        {
          id: body.model,
          name: body.model,
          reasoning: tuning.reasoning,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
          compat: tuning.compat,
          samplingParams: tuning.samplingParams,
        },
      ],
    });
    const model = modelRuntime.getModel("weaver", body.model);
    if (!model) {
      emit({ type: "error", message: `unknown model: ${body.model}` });
      return;
    }

    /**
     * The one tool the harness adds: it turns a URI into a media block. A
     * generic version of this, one block kind per call with that kind's own
     * JSON Schema for `data`, existed before; the model kept getting a
     * kind's own fields wrong. Media only, with the two fields it actually
     * needs, has no schema left to get wrong.
     */
    const displayMedia = defineTool({
      name: "display_media",
      label: "Display external media",
      description: [
        "Show the user a real file: an image, audio, video, PDF, or text file by URI, or a YouTube video by its watch/share/shorts URL.",
        "The file type comes from the extension in the path, so only pass a URI that ends in one of the supported extensions (png, jpg, mp4, mp3, pdf, txt, and so on). A URI with no extension, or one the viewer doesn't recognize, renders as a plain \"no preview\" placeholder instead of the actual file.",
        "If the only copy you have is extensionless (a download, a temp file, an attachment), write or copy it to a path that ends in the right extension first, then point this tool at that copy.",
        "A local file needs an absolute file:// URI, such as file:///home/me/diagram.png.",
      ].join("\n"),
      parameters: Type.Object({
        uri: Type.String({ description: "http(s)://, file://, or a YouTube URL" }),
        label: Type.String({ description: "Short label for the block" }),
      }),
      execute: async (_toolCallId, params) => {
        const answer = (text: string) => ({
          content: [{ type: "text" as const, text }],
          details: {},
        });
        // Thrown, not returned. The agent loop turns a throw into a failed
        // tool result, so a rejected call shows up as a failed one instead
        // of vanishing.
        const refuse = (text: string): never => {
          throw new Error(text);
        };
        const kind = ctx.kinds[MEDIA_KIND];
        if (!kind) throw new Error("media kind is not registered");
        const state = { uri: params.uri };
        try {
          // Validated here so the model is told what it got wrong while it
          // can still fix it, instead of the renderer rejecting the block
          // once the run is over.
          kind.parse(state);
        } catch (error) {
          refuse(schemaMessage(error));
        }
        ctx.registerPendingMedia?.(params.uri);
        emit({ type: "block", kind: MEDIA_KIND, label: params.label, data: state });
        return answer(`added a media block for ${params.uri}`);
      },
    });

    // Mount every tool the loaded plugins contribute. A plugin tool is a
    // narrow descriptor (see `@repo/plugins`); this wraps it in the SDK's
    // shape and hands a read-only settings context through, so a plugin
    // reads its own config without knowing the app's store.
    const mountedPluginTools = ctx.pluginTools.map((tool) =>
      defineTool({
        name: tool.name,
        label: tool.label,
        description: Array.isArray(tool.description)
          ? tool.description.join("\n")
          : tool.description,
        parameters: tool.parameters as Parameters<typeof defineTool>[0]["parameters"],
        execute: async (_toolCallId, args) => {
          const result = await tool.execute(
            args as Record<string, unknown>,
            { getSetting: ctx.getSetting },
          );
          return {
            content: [{ type: "text" as const, text: result.content }],
            details: result.details,
          };
        },
      }),
    );

    /**
     * The agent's working directory and environment. The block's own merged
     * environment (every `environment` block above it, closer overriding
     * farther) shades the host's own for this run: `WEAVER_PWD` becomes the
     * directory the agent starts in, and the remaining variables reach its
     * tools. A relative `WEAVER_PWD` resolves against the project root, the
     * same base the media protocol falls back to; an unset one leaves the
     * agent at the project root as before. On a remote run, `ctx.root` is
     * the server's own project root, so the same request acts on the
     * server's filesystem.
     */
    const agentEnv = { ...process.env, ...(body.env ?? {}) };
    const weaverPwd = agentEnv[WEAVER_PWD];
    const cwd = weaverPwd
      ? isAbsolute(weaverPwd)
        ? weaverPwd
        : resolve(ctx.root, weaverPwd)
      : ctx.root;

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: AGENT_DIR,
      // A weaver agent's instructions are its prompt plus the graph above
      // it. pi's own extensions, skills and context files are not part of
      // that, and would silently change what a block does.
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      // A replacement, not an append: pi's default prompt (CLI-agent
      // phrasing, SDK-built tool list) is replaced wholesale; this file is
      // the whole system prompt. Tools still reach the model through the
      // SDK's own tool array, so nothing about the tool list is lost.
      systemPrompt: WEAVER_SYSTEM_PROMPT,
    });
    await resourceLoader.reload();

    /**
     * Replaces the SDK's own `read` (bare filesystem paths only) with the
     * same name and `path`/`offset`/`limit` shape, but `path` may also be a
     * `file://`, `http(s)://` or `ssh://` URI. The tool registry resolves a
     * custom tool over a built-in one of the same name, so naming this
     * `read` makes the replacement automatic rather than a second tool to
     * choose between.
     */
    const read = defineTool({
      name: "read",
      label: "Read",
      description: [
        "Check what's actually in a file or directory, or fetch a webpage, instead of guessing. Every result is capped at about 4KB, so never expect a whole file's content.",
        "`path` is a filesystem path (relative to the project root, or absolute) or a URI: file://, http(s)://, ssh://[user@]host[:port]/path.",
        "Reading a whole code file (no window parameters) returns a symbol index: each top-level function, class, type, and so on, with its line number. Read the sections you need afterwards with `offset`/`limit`; the index tells you which lines to ask for.",
        "Reading a whole non-code file returns its first page, marked truncated when the file is longer. A directory lists its immediate entries, one per line, subdirectories marked with a trailing /; http(s):// only reads files.",
        "ssh:// requires the harness's host to already have ssh access to that host set up (key, agent, or ~/.ssh/config); it is not configured here.",
        "Default is line mode: 1-indexed `offset`/`limit`. Use `byteOffset`/`byteLength` (0-indexed) instead for one huge line: minified JS or a single long JSON blob. Pass one pair or the other, never both; neither applies to a directory.",
      ].join("\n"),
      parameters: Type.Object({
        path: Type.String({
          description:
            "Filesystem path, or file://, http(s)://, ssh:// URI",
        }),
        offset: Type.Optional(
          Type.Number({
            description: "Line number to start reading from (1-indexed)",
          }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Maximum number of lines to read" }),
        ),
        byteOffset: Type.Optional(
          Type.Number({ description: "Byte to start reading from (0-indexed)" }),
        ),
        byteLength: Type.Optional(
          Type.Number({ description: "Maximum number of bytes to read" }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        let result;
        try {
          result = await readSource(params.path, cwd, {
            offset: params.offset,
            limit: params.limit,
            byteOffset: params.byteOffset,
            byteLength: params.byteLength,
          });
        } catch (error) {
          throw new Error(
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        }
        const header = !result.truncated
          ? ""
          : result.byteStart !== undefined
            ? `[bytes ${result.byteStart}-${result.byteEnd}]\n\n`
            : result.totalLines !== undefined
              ? `[lines ${result.startLine}-${result.endLine} of ${result.totalLines}]\n\n`
              : `[lines ${result.startLine}-${result.endLine}+]\n\n`;
        return {
          content: [
            { type: "text" as const, text: `${header}${result.content}` },
          ],
          details: {},
        };
      },
    });

    /**
     * Replaces the SDK's own `write` with the same name and
     * `path`/`content` shape, but `path` may also be a `file://` or
     * `ssh://` URI. `http(s)://` is left out: writing to an arbitrary URL
     * has no general meaning, unlike reading one.
     */
    const write = defineTool({
      name: "write",
      label: "Write",
      description: [
        "Use this when the user wants a file created, or its content replaced outright. Creates the file if it doesn't exist, overwrites if it does, and creates parent directories automatically.",
        "`path` may be a filesystem path (relative to the project root, or absolute), a file:// URI, or an ssh://[user@]host[:port]/path URI.",
        "ssh:// requires the harness's host to already have ssh access to that host set up (key, agent, or ~/.ssh/config); it is not configured here.",
      ].join("\n"),
      parameters: Type.Object({
        path: Type.String({
          description: "Filesystem path, file://, or ssh:// URI",
        }),
        content: Type.String({ description: "Content to write" }),
      }),
      execute: async (_toolCallId, params) => {
        try {
          await writeSource(params.path, cwd, params.content);
        } catch (error) {
          throw new Error(
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        }
        return {
          content: [
            { type: "text" as const, text: `wrote ${params.content.length} bytes to ${params.path}` },
          ],
          details: {},
        };
      },
    });

    /**
     * Replaces the SDK's own `edit` with the same name and `path`/`edits[]`
     * shape (each edit an exact, unique `oldText`/`newText` pair, matched
     * against the original file rather than incrementally), but `path` may
     * also be a `file://` or `ssh://` URI. The tool's output is a unified
     * diff rather than a success message, so the block this call produces
     * shows the change instead of just naming it. `toolLanguage` in the
     * rich-media plugin always highlights an `edit` call's output as a diff,
     * regardless of the file it touched.
     */
    const edit = defineTool({
      name: "edit",
      label: "Edit",
      description: [
        "Use this to change part of a file without rewriting the whole thing. Each edits[].oldText must match exactly once in the original file and must not overlap any other edit in the same call.",
        "`path` may be a filesystem path (relative to the project root, or absolute), a file:// URI, or an ssh://[user@]host[:port]/path URI.",
        "ssh:// requires the harness's host to already have ssh access to that host set up (key, agent, or ~/.ssh/config); it is not configured here.",
        "For several changes in one file, pass multiple edits[] in a single call rather than calling edit repeatedly.",
      ].join("\n"),
      parameters: Type.Object({
        path: Type.String({
          description: "Filesystem path, file://, or ssh:// URI",
        }),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String({
              description:
                "Exact text for one targeted replacement. Must be unique in the original file and must not overlap any other edits[].oldText in the same call.",
            }),
            newText: Type.String({
              description: "Replacement text for this targeted edit.",
            }),
          }),
          { description: "Several targeted replacements" },
        ),
      }),
      execute: async (_toolCallId, params) => {
        let result;
        try {
          result = await editSource(params.path, cwd, params.edits);
        } catch (error) {
          throw new Error(
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        }
        return {
          content: [{ type: "text" as const, text: result.diff }],
          details: {},
        };
      },
    });

    const requested = body.tools.filter((name) =>
      (ALLOWED_TOOLS as readonly string[]).includes(name),
    );
    // Every built-in tool by default: this is a single-operator
    // harness, not a hosted service, so there is no untrusted third
    // party to hold `bash`/`write`/`edit` back from.
    const tools = requested.length > 0 ? requested : [...ALLOWED_TOOLS];

    const { session } = await createAgentSession({
      cwd,
      agentDir: AGENT_DIR,
      modelRuntime,
      model,
      // `ThinkingLevel` lives in `@earendil-works/pi-agent-core`, a
      // transitive dependency this package does not declare directly, so
      // this is a structural cast against `createAgentSession`'s own
      // parameter type instead of importing it. Undefined here means "no
      // preference"; the SDK falls back to its own default.
      thinkingLevel: tuning.thinkingLevel as NonNullable<
        Parameters<typeof createAgentSession>[0]
      >["thinkingLevel"],
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: [...tools, displayMedia.name],
      customTools: [displayMedia, ...mountedPluginTools, read, write, edit],
    });

    ctx.onSession?.(() => void session.abort());

    // Arguments arrive with the call and the result with its end, so they
    // are paired by id. A tool block shows what was asked as well as what
    // came back.
    const pendingArgs = new Map<string, string>();
    // Accumulated so `registerInlineMedia` sees a URI as soon as its
    // `![...](file://...)` closes, not only once the whole message is
    // final; the renderer mirrors every delta into the live block, so an
    // inline image can render mid-stream, well before `message_end`. Reset
    // per assistant message, since a run may take several turns.
    let assistantText = "";
    const unsubscribe = session.subscribe((sessionEvent) => {
      if (sessionEvent.type === "tool_execution_start") {
        pendingArgs.set(sessionEvent.toolCallId, JSON.stringify(sessionEvent.args ?? {}));
        return;
      }
      // Token-by-token streaming of the assistant's own words and, where
      // the model exposes it, its reasoning; the `text`/`thinking` events
      // at `message_end` below are still the authoritative full message,
      // so nothing here is deduplicated against them.
      if (sessionEvent.type === "message_update") {
        if (sessionEvent.assistantMessageEvent.type === "text_delta") {
          assistantText += sessionEvent.assistantMessageEvent.delta;
          registerInlineMedia(assistantText, ctx.registerPendingMedia);
          emit({ type: "text_delta", text: sessionEvent.assistantMessageEvent.delta });
        } else if (sessionEvent.assistantMessageEvent.type === "thinking_delta") {
          emit({ type: "thinking_delta", text: sessionEvent.assistantMessageEvent.delta });
        }
        return;
      }
      if (sessionEvent.type === "message_end") {
        assistantText = "";
        const failure = messageFailure(sessionEvent.message);
        if (failure) {
          emit({ type: "error", message: failure });
          return;
        }
        const thinking = messageThinking(sessionEvent.message);
        if (thinking) emit({ type: "thinking", text: thinking });
        const text = messageText(sessionEvent.message);
        if (text) {
          // Covers a non-streaming provider, which never fires `text_delta`.
          registerInlineMedia(text, ctx.registerPendingMedia);
          emit({ type: "text", text });
        }
        return;
      }
      if (sessionEvent.type === "tool_execution_end") {
        const args = pendingArgs.get(sessionEvent.toolCallId) ?? "";
        pendingArgs.delete(sessionEvent.toolCallId);
        // A successful `display_media` already emitted its block, so
        // recording the call as well would say nothing new. A rejected one
        // has nothing to show, and a silent failure is worse than a
        // visible one.
        if (sessionEvent.toolName === displayMedia.name && !sessionEvent.isError) return;
        emit({
          type: "tool",
          name: sessionEvent.toolName,
          args,
          output: resultText(sessionEvent.result),
          ok: !sessionEvent.isError,
        });
      }
    });

    const prompt = body.context
      ? [
          "<weaver_graph>",
          body.context,
          "</weaver_graph>",
          "",
          "---",
          "",
          body.prompt,
        ].join("\n")
      : body.prompt;

    // The agent's own tools spawn shells that inherit `process.env`, so the
    // block's variables reach them by shading `process.env` for the duration
    // of this run and restoring it afterwards — only the run's own settings
    // are touched, and only their exact previous values are put back. A
    // second, concurrent run shading the same key could interleave; runs are
    // short and this app drives one inference at a time, so that is a race
    // nobody has met yet rather than one to engineer around.
    const previousEnv = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(body.env ?? {})) {
      previousEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      await session.prompt(prompt);
    } finally {
      for (const [key, previous] of previousEnv) {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
    unsubscribe();
    session.dispose();
    emit({ type: "done" });
  } catch (error) {
    emit({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}