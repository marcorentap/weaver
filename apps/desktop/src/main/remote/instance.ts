import type { Server } from "node:http";
import { buildAgentRuntime } from "../lib/agent-runtime.js";
import { projectRoot } from "../lib/project.js";
import { loadRemoteKeyStore, type RemoteKeyStore } from "./keys.js";
import { createRemoteServer } from "./server.js";

/**
 * This machine's own remote instance: the single running server the
 * Settings "server" toggle switches on and off. The agent context is built
 * the same way the local agent's is, so a remote run executes exactly this
 * machine's plugins and reads this machine's plugin settings.
 */

let currentServer: Server | null = null;
let host = "0.0.0.0";
let port: number | null = null;
let keys: RemoteKeyStore | null = null;

/** The store of keys this machine has issued. */
export function instanceKeyStore(): RemoteKeyStore {
  keys ??= loadRemoteKeyStore();
  return keys;
}

export type RemoteInstanceStatus = {
  running: boolean;
  host: string;
  port: number | null;
  url: string | null;
};

export function remoteInstanceStatus(): RemoteInstanceStatus {
  if (!currentServer || port === null) {
    return { running: false, host, port: null, url: null };
  }
  const display = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  return { running: true, host, port, url: `http://${display}:${port}` };
}

/** Stops the running server, if any; resolves once it is closed. */
export function stopRemoteInstance(): Promise<void> {
  const server = currentServer;
  currentServer = null;
  port = null;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** Starts (or restarts, dropping any previous one) the server on
 *  `port`/`host`. A bind failure (port in use, bad address) resolves
 *  `ok: false` instead of throwing, so the Settings toggle can show it. */
export function startRemoteInstance(options: {
  host?: string;
  port: number;
  name?: string;
}): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    void stopRemoteInstance().then(() => {
      const nextHost = options.host?.trim() || "0.0.0.0";
      const { kinds, pluginTools, getSetting } = buildAgentRuntime();
      const server = createRemoteServer({
        agent: { kinds, pluginTools, getSetting },
        root: projectRoot(),
        name: options.name ?? "weaver",
        keys: instanceKeyStore(),
      });
      const onError = (error: Error & { code?: string }) => {
        server.close();
        resolve({
          ok: false,
          message:
            error.code === "EADDRINUSE"
              ? `port ${options.port} is already in use`
              : error.code === "EADDRNOTAVAIL"
                ? `cannot bind ${nextHost}:${options.port}`
                : `failed to start: ${error.message || String(error)}`,
        });
      };
      server.once("error", onError);
      server.listen(options.port, nextHost, () => {
        server.off("error", onError);
        currentServer = server;
        host = nextHost;
        port = options.port;
        resolve({
          ok: true,
          message: `listening on ${nextHost}:${options.port}`,
        });
      });
    });
  });
}