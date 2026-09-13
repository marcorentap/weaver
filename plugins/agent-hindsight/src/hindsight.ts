import { HindsightClient } from "@vectorize-io/hindsight-client";
import type { ToolRunContext } from "@repo/plugins";

/**
 * The plugin's id: the settings storage key, and the id the app's tool
 * context resolves settings under. Tools read their own config through
 * `ctx.getSetting` so they stay decoupled from the app's store.
 */
export const PLUGIN_ID = "agent-hindsight";

/** A live client plus the bank the plugin is configured to use by default. */
export type HindsightConnection = {
  client: HindsightClient;
  /** The configured bank, or undefined when none is set. */
  defaultBank?: string;
};

/**
 * Build a client from the plugin's settings. Throws a user-facing error
 * when the server URL is missing or not an http(s) URL, explaining where to
 * fix it, so a misconfigured plugin fails loudly instead of silently.
 */
export function connectHindsight(ctx: ToolRunContext): HindsightConnection {
  const baseUrl = ctx.getSetting(PLUGIN_ID, "baseUrl");
  if (!baseUrl) {
    throw new Error(
      "no Hindsight server configured: open Settings, the Agent Hindsight section, and point Base URL at a Hindsight server, e.g. http://localhost:8888",
    );
  }
  const trimmed = baseUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `invalid Hindsight Base URL "${trimmed}": needs a scheme and host, e.g. http://localhost:8888`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `invalid Hindsight Base URL "${trimmed}": needs an http(s) scheme, e.g. http://localhost:8888`,
    );
  }
  const apiKey = ctx.getSetting(PLUGIN_ID, "apiKey");
  return {
    client: new HindsightClient({
      baseUrl: url.toString().replace(/\/+$/, ""),
      ...(apiKey ? { apiKey } : {}),
    }),
    defaultBank: ctx.getSetting(PLUGIN_ID, "bankId"),
  };
}

/** Pick the bank a tool call targets: the call's own `bank` argument wins,
 *  then the configured default bank. Throws when neither is set. */
export function resolveBank(
  requested: unknown,
  connection: HindsightConnection,
): string {
  const fromCall = typeof requested === "string" && requested.trim() ? requested.trim() : undefined;
  const bank = fromCall ?? connection.defaultBank;
  if (!bank) {
    throw new Error(
      "no memory bank: pass a `bank` to this tool, or set one in Settings, the Agent Hindsight section (Bank Id)",
    );
  }
  return bank;
}

/** Turn a thrown value into an Error that carries its message, so an SDK or
 *  transport failure reads as a tool failure instead of a bare object. */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return new Error(error.message, { cause: error });
  }
  return new Error(String(error));
}