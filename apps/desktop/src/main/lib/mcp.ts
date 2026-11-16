import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { splitCommandLine, type McpServer } from "../../shared/mcp.js";

/** One content part of an MCP tool result, read loosely: the SDK types it as
 *  a union that includes shapes a tool result cannot carry, so the fields
 *  this module looks at are the ones it checks for. */
type McpPart = {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  /** A `resource_link`'s target, or the head of an embedded `resource`. */
  uri?: unknown;
  name?: unknown;
  description?: unknown;
  /** An embedded `resource`, whose own fields say whether it is text or a
   *  blob. */
  resource?: McpPart;
};

/** The two parts a harness tool result can carry, and the name of a part it
 *  cannot. */
type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** What one MCP tool call answers with. */
type McpCallResult = {
  content?: unknown[];
  /** A server's machine-readable result, beside the text it wrote for a
   *  person. Only read when the text came back empty. */
  structuredContent?: unknown;
  isError?: boolean;
};

/** The tool shape `run-agent.ts` mounts on a session, as far as this module
 *  cares: a name to offer it under, and a schema and call behind it. */
type MountedTool = ReturnType<typeof defineTool>;

/** Every MCP tool one run mounts, plus the way to let the servers go. */
export type McpMount = {
  tools: MountedTool[];
  /** Closes every connection this mount opened, and the server processes
   *  behind them. Idempotent, and safe to call after a partial mount. */
  close: () => Promise<void>;
};

/**
 * The name a server's tool is offered under.
 *
 * MCP says nothing about name collisions, and this harness mounts the
 * agent's tools, the plugins' and the SDK's own beside these, so a server's
 * tools are namespaced by the server's settings key: two servers may both
 * export `search`, and a person reading a `tool` block can still tell which
 * one answered. The characters are narrowed to what every provider accepts
 * in a function name — the same constraint the tool call's own id has to
 * satisfy, and one an MCP server has no reason to have thought about.
 */
function toolName(server: string, tool: string): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safe(server)}__${safe(tool)}`.slice(0, 64);
}

/**
 * Connects to every MCP server a run was configured with and lists what each
 * offers, wrapped as the harness's own tools.
 *
 * One connection per run, opened when the run starts and closed when it
 * ends. A run is short and its requests arrive with it — the endpoint and key
 * travel beside the servers for the same reason — so there is no process
 * state to keep in step with a settings page that may change between runs;
 * the cost is that a stdio server is spawned again for each run, which is
 * the price of not holding a child process open for a conversation nobody is
 * having.
 *
 * A server that cannot be reached fails the mount rather than being skipped.
 * A run configured to have a server's tools and quietly running without them
 * would answer as though the work had been done with less than it had; the
 * error names the server so the setting that caused it is a place to look.
 * Everything opened before the failure is closed on the way out.
 */
export async function mountMcpTools(
  servers: McpServer[],
  options: { cwd: string; env: Record<string, string | undefined> },
): Promise<McpMount> {
  const clients: Client[] = [];
  const tools: MountedTool[] = [];
  const close = async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
  };

  if (servers.length === 0) return { tools, close };

  try {
    for (const server of servers) {
      const client = new Client(
        { name: "weaver", version: "0.1.0" },
        { capabilities: {} },
      );
      // Registered before the connect so a transport that spawned a process
      // and then failed to initialize is still closed on the way out.
      clients.push(client);
      let said: () => string = () => "";
      try {
        const transport = transportFor(server, options);
        said = keepStderr(transport);
        await client.connect(transport);
        const listed = await client.listTools();
        for (const tool of listed.tools) {
          tools.push(wrapTool(server.name, client, tool));
        }
      } catch (error) {
        // Named here rather than left as it arrived: a spawn failure reads
        // `spawn npx ENOENT`, which says nothing about which server in a
        // run's settings asked for it. The child's own last words go with
        // it where there are any, because the SDK reports a server that
        // died during the handshake — the shape of nearly every wrong
        // command or package name — as a bare `Connection closed`, and
        // what the process printed on its way out is the only thing that
        // says why.
        const tail = said();
        throw new Error(
          `mcp server "${server.name}": ${
            error instanceof Error ? error.message : String(error)
          }${tail ? `\n${tail}` : ""}`,
          { cause: error },
        );
      }
    }
    return { tools, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Watches a stdio server's stderr and hands back a way to read the end of
 * what it said.
 *
 * The pipe is taken rather than inherited so that a server dying during the
 * handshake leaves evidence behind: the SDK's own error for that case names
 * nothing, and the process's last lines usually name everything (a missing
 * package, a bad flag, a port already taken). Only the tail is kept — the
 * last couple of thousand bytes, which is where a fatal message lands — and
 * a server that starts cleanly says nothing anyone reads.
 */
function keepStderr(transport: unknown): () => string {
  if (!(transport instanceof StdioClientTransport)) return () => "";
  const stream = transport.stderr;
  if (!stream) return () => "";
  let tail = "";
  stream.on("data", (chunk: unknown) => {
    tail = (tail + String(chunk)).slice(-2000);
  });
  return () => tail.trim();
}

/**
 * The transport one server's settings describe. A remote server's headers are
 * fixed at connect time, which is why they come from the settings rather
 * than from anything the run knows; a local server inherits the run's own
 * environment, so `WEAVER_PWD`'s variables reach it exactly as they reach the
 * harness's `bash`.
 *
 * A problem with the settings themselves is thrown unnamed, for
 * `mountMcpTools` to name once: an error that already says `mcp server
 * "x"` on the way out would be named twice by the time it reaches a
 * person.
 */
function transportFor(
  server: McpServer,
  options: { cwd: string; env: Record<string, string | undefined> },
) {
  if (server.transport === "http") {
    if (!server.url?.trim()) {
      throw new Error("has no URL for the HTTP transport");
    }
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      throw new Error(`has a URL that is not one: ${server.url}`);
    }
    return new StreamableHTTPClientTransport(url, {
      ...(server.headers && Object.keys(server.headers).length > 0
        ? { requestInit: { headers: server.headers } }
        : {}),
    });
  }

  const argv = splitCommandLine(server.command ?? "");
  const command = argv.shift();
  if (!command) {
    throw new Error("has no command for the stdio transport");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined) env[key] = value;
  }
  return new StdioClientTransport({
    command,
    args: argv,
    env,
    cwd: options.cwd,
    // See `keepStderr`: the pipe exists so a server that dies during the
    // handshake can be quoted at the person who configured it.
    stderr: "pipe",
  });
}

/**
 * One MCP content part as something a tool result can carry.
 *
 * Text and pictures are the two shapes this harness has a place for, so a
 * part of either kind crosses over as itself. The rest are MCP's own: an
 * embedded resource, a link to one, audio, or a kind this module has never
 * heard of. Those become text that says what they were — a link keeps its
 * URI, which is the whole of what a person would need to fetch it, and an
 * embedded text resource *is* text, so it arrives as the text it holds
 * rather than as a note that something went unread. Nothing is silently
 * dropped: a result that loses its links reads as a result that had none.
 */
function partToContent(
  server: string,
  tool: string,
  part: McpPart,
): ToolContent {
  const where = `${server}.${tool}`;
  if (part.type === "text" && typeof part.text === "string") {
    return { type: "text", text: part.text };
  }
  if (
    part.type === "image" &&
    typeof part.data === "string" &&
    typeof part.mimeType === "string"
  ) {
    return { type: "image", data: part.data, mimeType: part.mimeType };
  }
  if (part.type === "resource_link") {
    const label = typeof part.name === "string" ? part.name : "link";
    const described =
      typeof part.description === "string" ? ` — ${part.description}` : "";
    return {
      type: "text",
      text: `[${where} ${label}${described}: ${String(part.uri)}]`,
    };
  }
  if (part.type === "resource" && part.resource) {
    const embedded = part.resource;
    if (typeof embedded.text === "string") {
      return { type: "text", text: embedded.text };
    }
    const kind =
      typeof embedded.mimeType === "string" ? ` ${embedded.mimeType}` : "";
    return {
      type: "text",
      text: `[${where} embedded${kind} resource: ${String(embedded.uri)}]`,
    };
  }
  return {
    type: "text",
    text: `[${String(part.type ?? "unknown")} content from ${where}]`,
  };
}

/**
 * One MCP tool as the harness's own.
 *
 * The server's own `inputSchema` is passed through untouched — it is JSON
 * Schema, which is what the harness validates a call against, and rewriting
 * it would be guessing at a schema the server wrote — and a call is
 * forwarded as the arguments arrived.
 *
 * What comes back is a list of content parts, of which the harness can carry
 * two: text, and a picture. A picture is handed over as the part it already
 * is (the model sees it when it takes image input, and the block records
 * that a picture came back); anything else — a resource link, audio, an
 * embedded binary the SDK models as its own kind — is described in text, so
 * that a result nothing downstream can render still says what it was rather
 * than arriving empty.
 */
function wrapTool(
  server: string,
  client: Client,
  tool: Awaited<ReturnType<Client["listTools"]>>["tools"][number],
): MountedTool {
  return defineTool({
    name: toolName(server, tool.name),
    label: tool.annotations?.title ?? tool.name,
    description: `[${server}] ${tool.description ?? tool.name}`.trim(),
    // The MCP tool's schema is plain JSON Schema: the harness accepts one,
    // coercing and validating against it exactly as it does a TypeBox one,
    // so a server's parameters need no translation into a schema language
    // it never spoke.
    parameters: tool.inputSchema as unknown as TSchema,
    execute: async (_toolCallId, params, signal) => {
      let result: McpCallResult;
      try {
        // The SDK's own return type widens `content` to `unknown` because a
        // server may answer with a compatibility shape; the parts this
        // function understands are the ones below, and anything else already
        // falls through to the description its own `type` is.
        result = (await client.callTool(
          { name: tool.name, arguments: params as Record<string, unknown> },
          undefined,
          signal ? { signal } : undefined,
        )) as McpCallResult;
      } catch (error) {
        throw new Error(
          `mcp server "${server}" failed on "${tool.name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      const parts = (result.content ?? []) as McpPart[];
      const content = parts.map((part) =>
        partToContent(server, tool.name, part),
      );
      if (result.isError) {
        // The server's own words, gathered from whatever it said as text —
        // including an embedded text resource, which is text however it
        // arrived. A failure with nothing to quote still says it failed.
        const text = content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        throw new Error(text || `mcp server "${server}" reported a failure`);
      }
      if (content.length > 0) return { content, details: {} };
      // Nothing a person could read, but a server may still have answered:
      // a tool with an `outputSchema` returns its result as
      // `structuredContent`, and dropping it would turn a real answer into
      // an empty one.
      if (result.structuredContent !== undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.structuredContent, null, 2),
            },
          ],
          details: {},
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `mcp server "${server}" returned nothing`,
          },
        ],
        details: {},
      };
    },
  }) as MountedTool;
}
