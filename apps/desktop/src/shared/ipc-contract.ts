import type { BlockGraph, Position } from "@repo/core";
import type { BlockInput } from "@repo/store";
import type { AgentEvent, AgentRunRequest } from "./agent-events.js";
import type {
  RemoteCheckResult,
  RemoteCreateKeyRequest,
  RemoteCreateKeyResult,
  RemoteInstanceResult,
  RemoteInstanceStatus,
  RemoteKeySummary,
} from "./remote.js";

/**
 * The scheme a `weaver-media://` URL is served under. Registered as a
 * privileged, stream-capable scheme in the main process (see
 * `src/main/ipc/media-protocol.ts`) so `<img>`/`<video>`/`<audio>` tags and
 * plain `fetch()` in the renderer can address local `file://` bytes and
 * remote text the same way the old `/api/media` route did. A renderer page
 * cannot read `file://` bytes or CORS-less remote text on its own.
 */
export const MEDIA_PROTOCOL = "weaver-media";

/** Builds the `weaver-media://` URL for a stored media URI (`file://…`,
 *  `http(s)://…`). Pure string building. The main process does the actual
 *  allowlisting and byte-serving when the URL is requested. */
export function mediaProtocolUrl(uri: string): string {
  return `${MEDIA_PROTOCOL}://local/${encodeURIComponent(uri)}`;
}

export interface ChatSessionSummary {
  id: string;
  name: string;
  modifiedAt: number;
}

export interface LoadGraphResult {
  graph: BlockGraph;
  sessions: ChatSessionSummary[];
  session: { id: string; name: string } | null;
}

export interface MutationResult {
  error: string | null;
}

export interface CreateSessionResult extends MutationResult {
  id: string | null;
  /** The brand-new session's graph, as minted by the main process (the
   *  default `environment` block). Returned with the create so the renderer
   *  can seed a pane instantly without a follow-up `loadGraph` round trip. */
  graph?: BlockGraph;
}

export interface CheckResult {
  ok: boolean;
  message: string;
  /** Model ids the provider reports, when the probe reached `/models`. */
  models?: string[];
  /** Each reported model id's own `supported_parameters`, when the
   *  provider's `/models` response included them (OpenRouter does). Used
   *  to flag a provider setting a chosen model doesn't actually support,
   *  e.g. a thinking level on a model with no "reasoning" entry here. */
  modelParameters?: Record<string, string[]>;
}

/** OpenRouter's own per-key usage and credit limit, as reported by
 *  `GET /key`. `null` in `limit`/`limitRemaining` means the key has no
 *  cap of its own; account balance still applies separately. */
export interface ProviderUsageResult {
  ok: boolean;
  message: string;
  usage?: {
    label: string;
    limit: number | null;
    limitRemaining: number | null;
    usage: number;
    usageDaily: number;
    usageWeekly: number;
    usageMonthly: number;
    isFreeTier: boolean;
  };
}

/** One setting field a loaded plugin contributes, as it travels over IPC.
 *  Functions like a custom `validate` are stripped; editing and basic shape
 *  reasons still work from the remaining fields. */
export type PluginSettingFieldWire = {
  kind: "string" | "number" | "option";
  key: string;
  label: string;
  description: string;
  placeholder?: string;
  secret?: boolean;
  step?: number;
  min?: number;
  max?: number;
  options?: readonly { value: string; label: string }[];
  editable?: boolean;
};

/** A loaded plugin as the renderer sees it over `plugins:list`. */
export interface PluginSummary {
  id: string;
  name: string;
  description: string;
  settings?: PluginSettingFieldWire[];
}

/** Result of `plugins:list`: the configured directory and every plugin
 *  loaded from it, built-ins first. */
export interface PluginListResult {
  dir: string;
  plugins: PluginSummary[];
}

/**
 * The renderer-facing API `contextBridge` exposes as `window.api`. Every
 * `chat.*` method is a one-shot `ipcRenderer.invoke` request/response pair,
 * the direct replacement for the old Next.js server actions. `agent.run` is
 * the one push-based channel. It starts a run and streams `AgentEvent`s back
 * until `done`/`error`, because `invoke`/`handle` alone cannot carry an
 * open-ended event stream.
 */
export interface WeaverApi {
  chat: {
    loadGraph(session?: string): Promise<LoadGraphResult>;
    deleteChatBlock(graphId: string, id: string): Promise<MutationResult>;
    updateBlockField(
      graphId: string,
      blockId: string,
      name: string,
      value: string | number,
    ): Promise<MutationResult>;
    updateBlockLabel(
      graphId: string,
      blockId: string,
      label: string,
    ): Promise<MutationResult>;
    createChatBlock(
      graphId: string,
      input: BlockInput,
      at: Position,
    ): Promise<MutationResult>;
    moveChatBlock(
      graphId: string,
      blockId: string,
      at: Position,
    ): Promise<MutationResult>;
    createChatSession(name: string): Promise<CreateSessionResult>;
    renameChatSession(graphId: string, name: string): Promise<MutationResult>;
    /** Forks `graphId` into a new session (`<name> copy`) with fresh block
     *  ids, and returns the copy's id. */
    duplicateChatSession(graphId: string): Promise<CreateSessionResult>;
    deleteChatSession(graphId: string): Promise<MutationResult>;
    saveGraph(graphId: string, blocks: BlockInput[]): Promise<MutationResult>;
  };
  settings: {
    /** One opaque key/value row. `null` when the key has never been
     *  written. */
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  agent: {
    check(endpoint: string, apiKey: string): Promise<CheckResult>;
    /** Per-key usage and credit limit from OpenRouter's `GET /key`. Only
     *  meaningful when `endpoint` points at OpenRouter. */
    providerUsage(
      endpoint: string,
      apiKey: string,
    ): Promise<ProviderUsageResult>;
    /** Starts a run and subscribes `onEvent` to its events. Returns a
     *  `cancel` function that aborts the run and unsubscribes; also
     *  unsubscribes itself once a terminal (`done`/`error`) event arrives. */
    run(
      request: AgentRunRequest,
      onEvent: (event: AgentEvent) => void,
    ): () => void;
  };
  plugins: {
    /** The configured plugin directory and every loaded plugin. */
    list(): Promise<PluginListResult>;
  };
  keymap: {
    /** A leader key the page's own keydown will never see because the main
     *  process swallows it (so a menu accelerator or browser default can't
     *  fire first — Ctrl+W closing the window), forwarded here instead to be
     *  folded into the keymap's pending-chord state like a real keydown.
     *  Which keys are swallowed and what they're called is the single shared
     *  source in `keys.ts` (`SWALLOWED_KEYS`), so the two sides can't drift.
     *  Returns an unsubscribe. */
    onChordLeader(cb: (leader: string) => void): () => void;
  };
  remote: {
    /** Does the connection to the configured instance actually work, and
     *  which role does the given key have there? */
    check(host: string, port: number, key: string): Promise<RemoteCheckResult>;
    /** This machine's own server instance, the one Settings toggles. */
    instance: {
      status(): Promise<RemoteInstanceStatus>;
      start(port: number, host?: string): Promise<RemoteInstanceResult>;
      stop(): Promise<void>;
    };
    /** Keys this machine has issued. */
    keys: {
      list(): Promise<RemoteKeySummary[]>;
      create(request: RemoteCreateKeyRequest): Promise<RemoteCreateKeyResult>;
      revoke(id: string): Promise<void>;
    };
  };
}

declare global {
  interface Window {
    api: WeaverApi;
  }
}
