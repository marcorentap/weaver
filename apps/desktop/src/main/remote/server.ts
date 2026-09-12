import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentRunContext } from "../lib/run-agent.js";
import { runAgent } from "../lib/run-agent.js";
import type { RemoteKeyStore } from "./keys.js";

/**
 * The HTTP surface of one remote instance.
 *
 * A machine running weaver can expose its agent runner to any other weaver
 * app over the network. Every route requires a bearer token the instance
 * issued (`Authorization: Bearer wrk_…`), and every route runs *this
 * machine's* agent with *the caller's* request: the caller's AI endpoint,
 * key and model, but this machine's filesystem, project root and tools. The
 * graph stays with the caller; this is pure compute.
 *
 * Routes:
 *   GET  /v1/health — tells the caller who its key is on this instance.
 *   POST /v1/run    — an `AgentRunRequest` (see shared/agent-events); streams
 *                     back NDJSON `AgentEvent`s until a terminal event. The
 *                     client cancelling (closing) the request aborts the
 *                     session.
 */
export type RemoteServerOptions = {
  /** Enough of a run context to run agents; the per-run `root` and the
   *  abort wiring are supplied per request. */
  agent: Pick<AgentRunContext, "kinds" | "pluginTools" | "getSetting">;
  /** Directory a relative `WEAVER_PWD` resolves against and the default
   *  working directory when a block sets none: the server's project root. */
  root: string;
  name: string;
  keys: RemoteKeyStore;
};

const CONTENT_JSON = { "content-type": "application/json" } as const;

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  return scheme?.toLowerCase() === "bearer" && token && rest.length === 0
    ? token
    : null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, CONTENT_JSON);
  res.end(JSON.stringify(body));
}

/** A JSON request body, bounded so a huge upload cannot OOM the server. */
async function readJson(
  req: IncomingMessage,
  maxBytes = 16 * 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const wrapped = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += wrapped.length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(wrapped);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : undefined;
}

/** Creates (but does not listen on) the server; `listen()` is the caller's
 *  so bind errors surface where the caller can show them. */
export function createRemoteServer(options: RemoteServerOptions): Server {
  return createServer((req, res) => {
    void handleRequest(req, res, options);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: RemoteServerOptions,
): Promise<void> {
  const token = bearerToken(req);
  const principal = token ? options.keys.verify(token) : null;
  if (!principal) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    json(res, 400, { error: "bad request" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/health") {
    json(res, 200, { ok: true, name: options.name, admin: principal.admin });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/run") {
    await streamRun(req, res, options);
    return;
  }

  json(res, 404, { error: "not found" });
}

async function streamRun(
  req: IncomingMessage,
  res: ServerResponse,
  options: RemoteServerOptions,
): Promise<void> {
  let request: unknown;
  try {
    request = await readJson(req);
  } catch (error) {
    json(res, 400, {
      error: error instanceof Error ? error.message : "bad request body",
    });
    return;
  }

  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
  });
  res.flushHeaders();

  // Every write must survive the client having gone; it cancels a run by
  // closing the connection, which is exactly what aborts the session below.
  const aborts: (() => void)[] = [];
  let clientGone = false;
  req.on("close", () => {
    if (clientGone) return;
    clientGone = true;
    for (const abort of aborts) abort();
    aborts.length = 0;
  });
  const emit = (event: unknown) => {
    if (clientGone || res.destroyed) return;
    res.write(`${JSON.stringify(event)}\n`);
  };

  await runAgent(
    request,
    {
      root: options.root,
      kinds: options.agent.kinds,
      pluginTools: options.agent.pluginTools,
      getSetting: options.agent.getSetting,
      onSession: (abort) => {
        aborts.push(abort);
      },
    },
    emit,
  );

  if (!res.destroyed) res.end();
}