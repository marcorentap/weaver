import { Type } from "typebox";
import { z } from "zod";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { kinds } from "@/blocks/kinds";
import { TOOL_KIND } from "@/blocks/tool";
import {
  ALLOWED_TOOLS,
  READ_ONLY_TOOLS,
  agentRunRequest,
  type AgentEvent,
} from "@/lib/agent-events";
import { projectRoot } from "@/lib/project";
import { readSource } from "@/lib/read-source";
import {
  formatWebSearchResults,
  searchDuckDuckGo,
  type WebSearchResult,
} from "@/lib/web-search";
import { schemaMessage } from "@/lib/schema-error";

// The agent SDK reads the project and spawns processes, so this runs in Node
// and is never prerendered or cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Config directory handed to the SDK. Sessions are in-memory and every
 *  discovery pass is disabled, so nothing is actually read from it. */
const AGENT_DIR = "/tmp/weaver-agent";

/** A tool block is the harness's own record of a call rather than something
 *  to fabricate, so the `display` tool refuses to create one. */
const NOT_DISPLAYABLE = new Set<string>([TOOL_KIND]);

/**
 * The agent SDK types its event payloads as `any`, so everything crossing
 * that boundary is parsed rather than asserted — a shape change upstream
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
});

/** The kinds an agent may display, each with the JSON Schema of its state —
 *  derived from the kind registry, so registering a kind is all it takes to
 *  make it something the model can produce. */
function displayableKinds(): { kind: string; schema: unknown }[] {
  return Object.values(kinds).flatMap((kind) => {
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
 *  inlined: the bytes are already on disk and the browser has the path. */
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
 * turn and for every tool result too, so the role is checked first: without
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

export async function POST(request: Request): Promise<Response> {
  let body;
  try {
    body = agentRunRequest.parse(await request.json());
  } catch (error) {
    return Response.json(
      { error: { message: schemaMessage(error) } },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const displayable = displayableKinds();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: AgentEvent) => {
        if (!open) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const close = () => {
        if (!open) return;
        open = false;
        controller.close();
      };

      try {
        const modelRuntime = await ModelRuntime.create({
          // Nothing on disk: the endpoint and key come from the caller's
          // settings, and a catalog refresh per run would be a wasted round
          // trip for a provider list nobody reads.
          modelsPath: null,
          allowModelNetwork: false,
          refreshOnCreate: false,
        });
        modelRuntime.registerProvider("weaver", {
          baseUrl: body.endpoint,
          apiKey: body.apiKey,
          api: "openai-completions",
          models: [
            {
              id: body.model,
              name: body.model,
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 8192,
            },
          ],
        });
        const model = modelRuntime.getModel("weaver", body.model);
        if (!model) {
          emit({ type: "error", message: `unknown model: ${body.model}` });
          close();
          return;
        }

        /**
         * The one tool the harness adds: it turns anything the agent wants to
         * show into a real block. Its parameters are deliberately generic —
         * a kind plus that kind's own state — so "what an agent can display"
         * is exactly "which kinds exist", with no tool per kind to maintain.
         */
        const display = defineTool({
          name: "display",
          label: "Display",
          description: [
            "Add a block below your own block, to show something to the user.",
            "Pick the kind that fits what you are showing and pass that kind's state as `data`.",
            "Available kinds, with the JSON Schema of their `data`:",
            ...displayable.map(
              (entry) => `- ${entry.kind}: ${JSON.stringify(entry.schema)}`,
            ),
            'A media block shows an image, audio, video, PDF or text file by URI; a local file needs an absolute file:// URI, e.g. {"uri":"file:///home/me/diagram.png"}.',
            "A text block renders GitHub-flavoured markdown, so headings, lists, tables, fenced code and images are all available; an image needs an http(s) or absolute file:// URL.",
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
            // Thrown, not returned: the agent loop turns a throw into a
            // failed tool result, which is what makes a rejected display
            // show up as a failed call instead of vanishing.
            const refuse = (text: string): never => {
              throw new Error(text);
            };
            const kind = kinds[params.kind];
            if (!kind || NOT_DISPLAYABLE.has(params.kind)) {
              refuse(
                `no such kind: ${params.kind}. Available: ${displayable
                  .map((entry) => entry.kind)
                  .join(", ")}`,
              );
            }
            // `data` is an object in the schema, but a model handed a
            // schemaless parameter often sends the JSON as a string; both
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
              // it can still fix it, instead of the browser rejecting the
              // block once the run is over.
              kinds[params.kind]?.parse(state);
            } catch (error) {
              refuse(schemaMessage(error));
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

        /** DuckDuckGo web search — no API key, so it's safe to grant by
         *  default (see READ_ONLY_TOOLS). */
        const webSearch = defineTool({
          name: "web_search",
          label: "Web Search",
          description:
            "Search the web via DuckDuckGo and get back titles, URLs, and snippets. No API key required.",
          parameters: Type.Object({
            query: Type.String({ description: "Search query" }),
            limit: Type.Optional(
              Type.Number({
                description: "Max results to return (default 8, max 20)",
              }),
            ),
          }),
          execute: async (_toolCallId, params) => {
            let results: WebSearchResult[];
            try {
              results = await searchDuckDuckGo(params.query, {
                limit: params.limit,
              });
            } catch (error) {
              throw new Error(
                error instanceof Error ? error.message : String(error),
              );
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatWebSearchResults(params.query, results),
                },
              ],
              details: {},
            };
          },
        });

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
        });
        await resourceLoader.reload();

        /**
         * Replaces the SDK's own `read` (bare filesystem paths only): same
         * name and same `path`/`offset`/`limit` shape, but `path` may also
         * be a `file://`, `http(s)://` or `ssh://` URI. The tool registry
         * resolves a custom tool over a built-in one of the same name, so
         * naming this `read` is what makes the replacement automatic rather
         * than a second tool to choose between.
         */
        const read = defineTool({
          name: "read",
          label: "Read",
          description: [
            "Read a file and return its content, windowed either by line or by byte.",
            "`path` may be a filesystem path (relative to the project root, or absolute),",
            "or a URI: file://, http://, https://, or ssh://[user@]host[:port]/path.",
            "ssh:// requires the harness's host to already have ssh access to that host set up (key, agent, or ~/.ssh/config) — it is not configured here.",
            "Default is line mode: `offset`/`limit` window onto 1-indexed lines.",
            "For content a line boundary can't usefully cut — one huge line, e.g. minified JS or a single long JSON blob — use `byteOffset`/`byteLength` (0-indexed) instead. Pass one pair or the other, never both.",
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

        const requested = body.tools.filter((name) =>
          (ALLOWED_TOOLS as readonly string[]).includes(name),
        );
        const tools = requested.length > 0 ? requested : [...READ_ONLY_TOOLS];

        const { session } = await createAgentSession({
          cwd,
          agentDir: AGENT_DIR,
          modelRuntime,
          model,
          resourceLoader,
          sessionManager: SessionManager.inMemory(cwd),
          tools: [...tools, display.name],
          customTools: [display, webSearch, read],
        });

        // Arguments arrive with the call and the result with its end, so they
        // are paired by id: a tool block shows what was asked as well as what
        // came back.
        const pendingArgs = new Map<string, string>();
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "tool_execution_start") {
            pendingArgs.set(event.toolCallId, JSON.stringify(event.args ?? {}));
            return;
          }
          if (event.type === "message_end") {
            const text = messageText(event.message);
            if (text) emit({ type: "text", text });
            return;
          }
          if (event.type === "tool_execution_end") {
            const args = pendingArgs.get(event.toolCallId) ?? "";
            pendingArgs.delete(event.toolCallId);
            // A successful `display` already emitted its block, so recording
            // the call as well would say nothing new — but a rejected one has
            // nothing to show, and a silent failure is worse than a visible
            // one.
            if (event.toolName === display.name && !event.isError) return;
            emit({
              type: "tool",
              name: event.toolName,
              args,
              output: resultText(event.result),
              ok: !event.isError,
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

        // A browser that navigated away is not worth finishing a run for.
        request.signal.addEventListener("abort", () => {
          void session.abort();
        });

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
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
}
