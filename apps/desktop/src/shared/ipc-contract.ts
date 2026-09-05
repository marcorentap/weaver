import type { BlockGraph, Position } from "@repo/core";
import type { BlockInput } from "@repo/store";
import type { AgentEvent, AgentRunRequest } from "./agent-events.js";

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
}

export interface CheckResult {
  ok: boolean;
  message: string;
  /** Model ids the provider reports, when the probe reached `/models`. */
  models?: string[];
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
    /** Starts a run and subscribes `onEvent` to its events. Returns a
     *  `cancel` function that aborts the run and unsubscribes; also
     *  unsubscribes itself once a terminal (`done`/`error`) event arrives. */
    run(
      request: AgentRunRequest,
      onEvent: (event: AgentEvent) => void,
    ): () => void;
  };
}

declare global {
  interface Window {
    api: WeaverApi;
  }
}
