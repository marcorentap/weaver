import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { z } from "zod";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { OpenRouterRouting } from "@earendil-works/pi-ai";
import type { ToolRunContext } from "@repo/plugins";
import { MEDIA_KIND, TOOL_KIND } from "@plugins/rich-media";
import {
  ALLOWED_TOOLS,
  agentRunRequest,
  type AgentEvent,
  type AgentRunRequest,
} from "../../shared/agent-events.js";
import type { CheckResult, ProviderUsageResult } from "../../shared/ipc-contract.js";
import { projectRoot } from "../lib/project.js";
import { providerUrl } from "../lib/provider.js";
import { readSource } from "../lib/read-source.js";
import { writeSource } from "../lib/write-source.js";
import { editSource } from "../lib/edit-source.js";
import { loadedPlugins } from "../lib/plugins.js";
import { schemaMessage } from "../lib/schema-error.js";
import { getStore } from "../lib/store.js";
import { registerPendingMedia } from "../lib/pending-media.js";

/** Config directory handed to the agent. Sessions are in-memory and every
 *  discovery pass is disabled, so nothing is actually read from it. */
const AGENT_DIR = "/tmp/weaver-agent";

/**
 * A plugin's settings, one JSON blob per plugin id under a per-plugin store
 * key. Plugins read their own config through `toolRunContext`, so they stay
 * decoupled from the renderer and the app's settings shape.
 */
function pluginSettings(pluginId: string): Record<string, unknown> {
  const raw = getStore().getSetting(`weaver.plugins.${pluginId}`);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Handed to every plugin tool's `execute`: the store, behind the one getter
 *  the framework exposes. */
const toolRunContext: ToolRunContext = {
  getSetting: (pluginId, key) => {
    const value = pluginSettings(pluginId)[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  },
};

/** A tool block is the harness's own record of a call rather than something
 *  to fabricate, so the `display` tool refuses to create one. */
const NOT_DISPLAYABLE = new Set<string>([TOOL_KIND]);

/**
 * Appended to the SDK's own system prompt (see `resourceLoader` below).
 * Everything here is what's specific to running as one block in a weaver
 * graph rather than as a general-purpose repo-editing CLI agent. Kept as its
 * own committed file rather than an inline string so it reads and diffs like
 * prose, not code.
 *
 * Bundled main-process code is a single flattened `out/main/index.js`, so
 * `__dirname` at run time is `out/main`, the same directory
 * `vite-plugin-static-copy` (see electron.vite.config.ts) copies
 * `agent/system-prompt.md` into.
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
        mimeType: z.string().optional(),
      }),
    )
    .optional(),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
});

/** The kinds an agent can display, each with the JSON Schema of its state.
 *  Derived from the kind registry, so a plugin registering a kind is all it
 *  takes to make it something the model can produce. */
function displayableKinds(): { kind: string; schema: unknown }[] {
  return Object.values(loadedPlugins().kinds).flatMap((kind) => {
    if (NOT_DISPLAYABLE.has(kind.kind)) return [];
    try {
      return [{ kind: kind.kind, schema: z.toJSONSchema(kind.schema) }];
    } catch {
      // A kind whose schema has no JSON Schema form is simply not offered,
      // rather than taking the whole run down with it.
      return [];
    }
  });
}

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
 * output twice. Tool calls become their own blocks and thinking is dropped,
 * so only spoken text is left.
 */
function messageText(message: unknown): string {
  const parsed = contentParts.safeParse(message);
  if (!parsed.success || parsed.data.role !== "assistant") return "";
  return (parsed.data.content ?? [])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
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

/** In-flight runs, keyed by `runId`, so `agent:run:cancel` can abort one
 *  without a `Request`/`AbortSignal` to listen on. Entries are removed once
 *  a run reaches `done`/`error` on its own, or once cancelled. */
const runs = new Map<string, { abort: () => void }>();

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

/** Turns the renderer's `providerId`/`providerSettings` into OpenRouter's
 *  request shape: `only`/`sort` become the `provider` routing object; a
 *  thinking level marks the model reasoning-capable and sets the session's
 *  thinking level. Any other provider, or none set, is a no-op. */
function openRouterTuning(
  providerId: string | undefined,
  providerSettings: Record<string, string> | undefined,
): {
  compat?: { openRouterRouting?: OpenRouterRouting; thinkingFormat?: "openrouter" };
  reasoning: boolean;
  thinkingLevel?: (typeof THINKING_LEVELS)[number];
} {
  if (providerId !== "openrouter" || !providerSettings) return { reasoning: false };
  const only = (providerSettings.only ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
  const sort = providerSettings.sort?.trim();
  const routing: OpenRouterRouting = {};
  if (only.length > 0) routing.only = only;
  if (sort) routing.sort = sort;
  const thinkingRaw = providerSettings.thinkingLevel?.trim();
  const thinkingLevel = (THINKING_LEVELS as readonly string[]).includes(
    thinkingRaw ?? "",
  )
    ? (thinkingRaw as (typeof THINKING_LEVELS)[number])
    : undefined;
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

async function runAgent(
  event: IpcMainInvokeEvent,
  runId: string,
  rawRequest: AgentRunRequest,
): Promise<void> {
  const channel = `agent:run:event:${runId}`;
  const emit = (agentEvent: AgentEvent) => {
    event.sender.send(channel, agentEvent);
  };

  let body: AgentRunRequest;
  try {
    body = agentRunRequest.parse(rawRequest);
  } catch (error) {
    emit({ type: "error", message: schemaMessage(error) });
    return;
  }

  const displayable = displayableKinds();

  try {
    const modelRuntime = await ModelRuntime.create({
      // Nothing on disk: the endpoint and key come from the caller's
      // settings, and a catalog refresh per run would be a wasted round
      // trip for a provider list nobody reads.
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const tuning = openRouterTuning(body.providerId, body.providerSettings);
    modelRuntime.registerProvider("weaver", {
      baseUrl: body.endpoint,
      apiKey: body.apiKey,
      api: "openai-completions",
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
        },
      ],
    });
    const model = modelRuntime.getModel("weaver", body.model);
    if (!model) {
      emit({ type: "error", message: `unknown model: ${body.model}` });
      return;
    }

    /**
     * The one tool the harness adds: it turns anything the agent wants to
     * show into a real block. Its parameters are deliberately generic: a
     * kind plus that kind's own state, so "what an agent can display" is
     * exactly "which kinds exist", with no tool per kind to maintain.
     */
    const display = defineTool({
      name: "display",
      label: "Display",
      description: [
        "Use this to show the user something concrete: code, a diagram, a fetched page, structured data. Don't just describe it in your reply, add a block for it.",
        "Pick the kind that fits and pass its state as `data`. Available kinds, with the JSON Schema of their `data`:",
        ...displayable.map(
          (entry) => `- ${entry.kind}: ${JSON.stringify(entry.schema)}`,
        ),
        'Media: an image, audio, video, PDF, or text file by URI, or a YouTube video by its watch/share/shorts URL. The file type comes from the extension in the path, so only pass a URI that ends in one of the supported extensions (png, jpg, mp4, mp3, pdf, txt, and so on). A URI with no extension, or one the viewer doesn\'t recognize, renders as a plain "no preview" placeholder instead of the actual file, so don\'t use this kind for extensionless paths. If the only copy you have is extensionless (a download, a temp file, an attachment), write or copy it to a path that ends in the right extension first, then point this block at that copy. A local file needs an absolute file:// URI, such as {"uri":"file:///home/me/diagram.png"}.',
        "Text: renders GitHub-flavoured markdown, so headings, lists, tables, fenced code and images all work; an image needs an http(s) or absolute file:// URL.",
        "A `Text` block is already visible. Don't restate its content in your reply. Summarizing is fine.",
      ].join("\n"),
      parameters: Type.Object({
        kind: Type.String({ description: "Block kind to create" }),
        label: Type.String({ description: "Short label for the block" }),
        data: Type.Unknown({
          description: "State for that kind, matching its schema",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const answer = (text: string) => ({
          content: [{ type: "text" as const, text }],
          details: {},
        });
        // Thrown, not returned. The agent loop turns a throw into a failed
        // tool result, so a rejected display shows up as a failed call
        // instead of vanishing.
        const refuse = (text: string): never => {
          throw new Error(text);
        };
        const kind = loadedPlugins().kinds[params.kind];
        if (!kind || NOT_DISPLAYABLE.has(params.kind)) {
          refuse(
            `no such kind: ${params.kind}. Available: ${displayable
              .map((entry) => entry.kind)
              .join(", ")}`,
          );
        }
        // `data` is an object in the schema, but a model handed a
        // schemaless parameter often sends the JSON as a string. Both
        // mean the same thing, so both are accepted.
        const raw =
          typeof params.data === "string"
            ? ((): unknown => {
                try {
                  return JSON.parse(params.data as string);
                } catch {
                  return refuse("data is not valid JSON");
                }
              })()
            : params.data;
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          refuse("data must be an object of that kind's fields");
        }
        // A record, per the check above; the schema decides the rest.
        const state = raw as Record<string, unknown>;
        try {
          // Validated here so the model is told what it got wrong while
          // it can still fix it, instead of the renderer rejecting the
          // block once the run is over.
          loadedPlugins().kinds[params.kind]?.parse(state);
        } catch (error) {
          refuse(schemaMessage(error));
        }
        // A file this block points at is not in the store until the next
        // autosave, so the media protocol would refuse it on the renderer's
        // first request. Say "this is about to be shown" ahead of that so
        // the fresh block displays without a reload (see pending-media.ts).
        if (params.kind === MEDIA_KIND && typeof state.uri === "string") {
          registerPendingMedia(state.uri);
        }
        emit({
          type: "block",
          kind: params.kind,
          label: params.label,
          data: state,
        });
        return answer(`displayed a ${params.kind} block`);
      },
    });

    // Mount every tool the loaded plugins contribute. A plugin tool is a
    // narrow descriptor (see `@repo/plugins`); this wraps it in the SDK's
    // shape and hands a read-only settings context through, so a plugin
    // reads its own config without knowing the app's store.
    const mountedPluginTools = loadedPlugins().tools.map((tool) =>
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
            toolRunContext,
          );
          return {
            content: [{ type: "text" as const, text: result.content }],
            details: result.details,
          };
        },
      }),
    );

    const cwd = projectRoot();

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
      // Appended, not a replacement. The SDK's own prompt already lists
      // the enabled tools and default guidelines from `tools` below; this
      // only adds what is specific to running as a weaver block instead
      // of a repo-editing CLI agent.
      appendSystemPrompt: [WEAVER_SYSTEM_PROMPT],
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
        "Use this to check what's actually in a file, or to visit or fetch a webpage, instead of guessing. Windows the result by line or by byte.",
        "`path` is a filesystem path (relative to the project root, or absolute) or a URI: file://, http://, https://, or ssh://[user@]host[:port]/path.",
        "ssh:// requires the harness's host to already have ssh access to that host set up (key, agent, or ~/.ssh/config); it is not configured here.",
        "Default is line mode: `offset`/`limit` window onto 1-indexed lines.",
        "Use `byteOffset`/`byteLength` (0-indexed) instead for one huge line: minified JS or a single long JSON blob. Pass one pair or the other, never both.",
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
            : `[lines ${result.startLine}-${result.endLine} of ${result.totalLines}]\n\n`;
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
            {
              type: "text" as const,
              text: `wrote ${params.content.length} bytes to ${params.path}`,
            },
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
     * renders the change instead of just naming it. `toolLanguage` in the
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
        "For several changes in one file, pass multiple entries in edits[] in a single call rather than calling edit repeatedly.",
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
          { description: "One or more targeted replacements" },
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
      tools: [...tools, display.name],
      customTools: [display, ...mountedPluginTools, read, write, edit],
    });

    runs.set(runId, { abort: () => void session.abort() });

    // Arguments arrive with the call and the result with its end, so they
    // are paired by id. A tool block shows what was asked as well as what
    // came back.
    const pendingArgs = new Map<string, string>();
    const unsubscribe = session.subscribe((sessionEvent) => {
      if (sessionEvent.type === "tool_execution_start") {
        pendingArgs.set(sessionEvent.toolCallId, JSON.stringify(sessionEvent.args ?? {}));
        return;
      }
      // Token-by-token streaming of the assistant's own words; the
      // `text` event at `message_end` below is still the authoritative
      // full message, so nothing here is deduplicated against it.
      if (sessionEvent.type === "message_update") {
        if (sessionEvent.assistantMessageEvent.type === "text_delta") {
          emit({ type: "text_delta", text: sessionEvent.assistantMessageEvent.delta });
        }
        return;
      }
      if (sessionEvent.type === "message_end") {
        const failure = messageFailure(sessionEvent.message);
        if (failure) {
          emit({ type: "error", message: failure });
          return;
        }
        const text = messageText(sessionEvent.message);
        if (text) emit({ type: "text", text });
        return;
      }
      if (sessionEvent.type === "tool_execution_end") {
        const args = pendingArgs.get(sessionEvent.toolCallId) ?? "";
        pendingArgs.delete(sessionEvent.toolCallId);
        // A successful `display` already emitted its block, so recording
        // the call as well would say nothing new. A rejected one has
        // nothing to show, and a silent failure is worse than a visible
        // one.
        if (sessionEvent.toolName === display.name && !sessionEvent.isError) return;
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
          "This is the context that comes before you in the graph:",
          "",
          body.context,
          "",
          "---",
          "",
          body.prompt,
        ].join("\n")
      : body.prompt;

    await session.prompt(prompt);
    unsubscribe();
    session.dispose();
    emit({ type: "done" });
  } catch (error) {
    emit({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    runs.delete(runId);
  }
}

const checkRequestBody = z.object({
  endpoint: z.string(),
  apiKey: z.string(),
});

/** A provider's `/models` listing, as far as this check cares. */
const modelsResponse = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        supported_parameters: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  error: z.union([z.string(), z.object({ message: z.string() })]).nullish(),
});

/**
 * Answers "do these credentials actually work?" so settings can say so the
 * moment they are typed, instead of leaving the first failure to surface
 * during an agent run.
 *
 * `GET /models` is the probe: every OpenAI-completions provider serves it,
 * it needs the same bearer token a completion does, and it costs nothing.
 * The verdict is always `{ ok, message }`. A failed probe is still a
 * successful check, and collapsing the two would make the caller handle
 * transport errors twice.
 */
async function checkAgent(endpoint: string, apiKey: string): Promise<CheckResult> {
  let body: z.infer<typeof checkRequestBody>;
  try {
    body = checkRequestBody.parse({ endpoint, apiKey });
  } catch {
    return { ok: false, message: "malformed check request" };
  }

  const url = providerUrl(body.endpoint, "models");
  if (!url) {
    return {
      ok: false,
      message: "not a valid URL. It needs a scheme and host",
    };
  }
  if (!body.apiKey) {
    return { ok: false, message: "no API key set" };
  }

  const upstream = await fetch(url, {
    headers: { authorization: `Bearer ${body.apiKey}` },
  }).catch((error: unknown) => {
    console.error(`provider check: fetch to ${url} failed:`, error);
    return null;
  });

  if (!upstream) {
    return { ok: false, message: `cannot reach ${url}` };
  }

  const raw = await upstream.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: `HTTP ${upstream.status}: ${raw.slice(0, 120) || "(empty response)"}`,
    };
  }

  const parsed = modelsResponse.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      message: `HTTP ${upstream.status}: unexpected response from ${url}`,
    };
  }

  const failure =
    typeof parsed.data.error === "string"
      ? parsed.data.error
      : parsed.data.error?.message;
  if (failure) return { ok: false, message: failure };

  if (!upstream.ok) {
    return {
      ok: false,
      message:
        upstream.status === 401 || upstream.status === 403
          ? `HTTP ${upstream.status}. API key rejected`
          : `HTTP ${upstream.status}`,
    };
  }

  const models = parsed.data.data ?? [];
  const modelIds = models.map((model) => model.id);
  const modelParameters = Object.fromEntries(
    models
      .filter((model) => model.supported_parameters)
      .map((model) => [model.id, model.supported_parameters!]),
  );
  return {
    ok: true,
    message:
      modelIds.length > 0
        ? `reachable, ${modelIds.length} models`
        : "reachable",
    models: modelIds,
    modelParameters,
  };
}

/** OpenRouter's `GET /key` response, as far as the settings usage panel
 *  cares. See https://openrouter.ai/docs/api_reference/limits. */
const keyResponse = z.object({
  data: z.object({
    label: z.string(),
    limit: z.number().nullable(),
    limit_remaining: z.number().nullable(),
    usage: z.number(),
    usage_daily: z.number(),
    usage_weekly: z.number(),
    usage_monthly: z.number(),
    is_free_tier: z.boolean(),
  }),
});

/**
 * OpenRouter's key-scoped credit limit and how much of it is spent today,
 * this week, this month, and all time. Same probe shape as `checkAgent`,
 * against `GET /key` instead of `GET /models`. There is no equivalent
 * endpoint for other providers, so this always targets OpenRouter and does
 * not try to detect a provider from `endpoint` itself.
 */
async function checkProviderUsage(
  endpoint: string,
  apiKey: string,
): Promise<ProviderUsageResult> {
  const url = providerUrl(endpoint, "key");
  if (!url) {
    return { ok: false, message: "not a valid URL. It needs a scheme and host" };
  }
  if (!apiKey) return { ok: false, message: "no API key set" };

  const upstream = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  }).catch((error: unknown) => {
    console.error(`provider usage: fetch to ${url} failed:`, error);
    return null;
  });
  if (!upstream) return { ok: false, message: `cannot reach ${url}` };

  const raw = await upstream.text();
  if (!upstream.ok) {
    return {
      ok: false,
      message:
        upstream.status === 401 || upstream.status === 403
          ? `HTTP ${upstream.status}. API key rejected`
          : `HTTP ${upstream.status}: ${raw.slice(0, 120) || "(empty response)"}`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: `HTTP ${upstream.status}: unexpected response from ${url}`,
    };
  }
  const parsed = keyResponse.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, message: `unexpected response shape from ${url}` };
  }
  const data = parsed.data.data;
  return {
    ok: true,
    message: "reachable",
    usage: {
      label: data.label,
      limit: data.limit,
      limitRemaining: data.limit_remaining,
      usage: data.usage,
      usageDaily: data.usage_daily,
      usageWeekly: data.usage_weekly,
      usageMonthly: data.usage_monthly,
      isFreeTier: data.is_free_tier,
    },
  };
}

export function registerAgentHandlers(): void {
  ipcMain.handle("agent:check", (_event, endpoint: string, apiKey: string) =>
    checkAgent(endpoint, apiKey),
  );
  ipcMain.handle(
    "agent:providerUsage",
    (_event, endpoint: string, apiKey: string) =>
      checkProviderUsage(endpoint, apiKey),
  );
  ipcMain.handle(
    "agent:run:start",
    (event, runId: string, request: AgentRunRequest) => runAgent(event, runId, request),
  );
  ipcMain.handle("agent:run:cancel", (_event, runId: string) => {
    runs.get(runId)?.abort();
    runs.delete(runId);
  });
}
