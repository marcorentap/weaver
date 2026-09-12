import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentEvent,
  AgentRunRequest,
} from "../shared/agent-events.js";
import type {
  CheckResult,
  CreateSessionResult,
  LoadGraphResult,
  MutationResult,
  PluginListResult,
  ProviderUsageResult,
  WeaverApi,
} from "../shared/ipc-contract.js";
import type {
  RemoteCheckResult,
  RemoteCreateKeyRequest,
  RemoteCreateKeyResult,
  RemoteInstanceResult,
  RemoteInstanceStatus,
  RemoteKeySummary,
} from "../shared/remote.js";
import type { BlockInput } from "@repo/store";
import type { Position } from "@repo/core";

/**
 * The only Node-capable surface exposed to the renderer. Every method here
 * is a thin, typed wrapper over `ipcRenderer`. The renderer itself runs
 * with `contextIsolation`/no direct Node access, matching how the old
 * Next.js build kept the SQLite store and process-spawning tools out of the
 * browser bundle.
 */
const api: WeaverApi = {
  chat: {
    loadGraph: (session) =>
      ipcRenderer.invoke("chat:loadGraph", session) as Promise<LoadGraphResult>,
    deleteChatBlock: (graphId, id) =>
      ipcRenderer.invoke("chat:deleteChatBlock", graphId, id) as Promise<MutationResult>,
    updateBlockField: (graphId, blockId, name, value) =>
      ipcRenderer.invoke(
        "chat:updateBlockField",
        graphId,
        blockId,
        name,
        value,
      ) as Promise<MutationResult>,
    updateBlockLabel: (graphId, blockId, label) =>
      ipcRenderer.invoke(
        "chat:updateBlockLabel",
        graphId,
        blockId,
        label,
      ) as Promise<MutationResult>,
    createChatBlock: (graphId, input: BlockInput, at: Position) =>
      ipcRenderer.invoke("chat:createChatBlock", graphId, input, at) as Promise<MutationResult>,
    moveChatBlock: (graphId, blockId, at: Position) =>
      ipcRenderer.invoke("chat:moveChatBlock", graphId, blockId, at) as Promise<MutationResult>,
    createChatSession: (name) =>
      ipcRenderer.invoke("chat:createChatSession", name) as Promise<CreateSessionResult>,
    renameChatSession: (graphId, name) =>
      ipcRenderer.invoke("chat:renameChatSession", graphId, name) as Promise<MutationResult>,
    duplicateChatSession: (graphId) =>
      ipcRenderer.invoke(
        "chat:duplicateChatSession",
        graphId,
      ) as Promise<CreateSessionResult>,
    deleteChatSession: (graphId) =>
      ipcRenderer.invoke("chat:deleteChatSession", graphId) as Promise<MutationResult>,
    saveGraph: (graphId, blocks: BlockInput[]) =>
      ipcRenderer.invoke("chat:saveGraph", graphId, blocks) as Promise<MutationResult>,
  },
  settings: {
    get: (key: string) =>
      ipcRenderer.invoke("settings:get", key) as Promise<string | null>,
    set: (key: string, value: string) =>
      ipcRenderer.invoke("settings:set", key, value) as Promise<void>,
  },
  plugins: {
    list: () =>
      ipcRenderer.invoke("plugins:list") as Promise<PluginListResult>,
  },
  agent: {
    check: (endpoint, apiKey) =>
      ipcRenderer.invoke("agent:check", endpoint, apiKey) as Promise<CheckResult>,
    providerUsage: (endpoint, apiKey) =>
      ipcRenderer.invoke(
        "agent:providerUsage",
        endpoint,
        apiKey,
      ) as Promise<ProviderUsageResult>,
    run: (request: AgentRunRequest, onEvent: (event: AgentEvent) => void) => {
      const runId = crypto.randomUUID();
      const channel = `agent:run:event:${runId}`;
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        ipcRenderer.removeListener(channel, listener);
      };
      const listener = (_event: Electron.IpcRendererEvent, event: AgentEvent) => {
        onEvent(event);
        if (event.type === "done" || event.type === "error") cleanup();
      };
      ipcRenderer.on(channel, listener);
      void ipcRenderer.invoke("agent:run:start", runId, request);
      return () => {
        if (done) return;
        void ipcRenderer.invoke("agent:run:cancel", runId);
        cleanup();
      };
    },
  },
  remote: {
    check: (host, port, key) =>
      ipcRenderer.invoke("remote:check", host, port, key) as Promise<RemoteCheckResult>,
    instance: {
      status: () =>
        ipcRenderer.invoke("remote:instance:status") as Promise<RemoteInstanceStatus>,
      start: (port, host) =>
        ipcRenderer.invoke(
          "remote:instance:start",
          port,
          host,
        ) as Promise<RemoteInstanceResult>,
      stop: () =>
        ipcRenderer.invoke("remote:instance:stop") as Promise<void>,
    },
    keys: {
      list: () =>
        ipcRenderer.invoke("remote:keys:list") as Promise<RemoteKeySummary[]>,
      create: (request: RemoteCreateKeyRequest) =>
        ipcRenderer.invoke("remote:keys:create", request) as Promise<RemoteCreateKeyResult>,
      revoke: (id: string) =>
        ipcRenderer.invoke("remote:keys:revoke", id) as Promise<void>,
    },
  },
};

contextBridge.exposeInMainWorld("api", api);
