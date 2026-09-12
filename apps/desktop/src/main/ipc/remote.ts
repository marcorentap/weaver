import { ipcMain } from "electron";
import {
  readRemoteServerSettings,
  remoteBaseUrl,
} from "../lib/remote-settings.js";
import {
  instanceKeyStore,
  remoteInstanceStatus,
  startRemoteInstance,
  stopRemoteInstance,
} from "../remote/instance.js";
import type {
  RemoteCheckResult,
  RemoteCreateKeyRequest,
  RemoteCreateKeyResult,
  RemoteInstanceResult,
} from "../../shared/remote.js";

/**
 * IPC surface for remote mode. Three concerns live here:
 *
 *  - `remote:check` — "do these url/port/key credentials actually reach an
 *    instance?", the connection counterpart of `agent:check`.
 *  - `remote:instance:*` — this machine's own server: its status, and the
 *    toggle that starts/stops it.
 *  - `remote:keys:*` — the keys this machine has issued: list, create with
 *    a lifetime, revoke. These manage the *own* instance directly on disk;
 *    there is deliberately no route to manage a remote machine's keys over
 *    HTTP — its operator does that on its own Settings page.
 */

export function registerRemoteHandlers(): void {
  ipcMain.handle(
    "remote:check",
    (_event, host: string, port: number, key: string): Promise<RemoteCheckResult> =>
      checkRemote(host, port, key),
  );

  ipcMain.handle("remote:instance:status", () =>
    Promise.resolve(remoteInstanceStatus()),
  );
  ipcMain.handle(
    "remote:instance:start",
    (_event, port: number, host?: string): Promise<RemoteInstanceResult> =>
      startRemoteInstance({ host, port }),
  );
  ipcMain.handle("remote:instance:stop", () => stopRemoteInstance());

  ipcMain.handle("remote:keys:list", () =>
    Promise.resolve(instanceKeyStore().list()),
  );
  ipcMain.handle(
    "remote:keys:create",
    (_event, request: RemoteCreateKeyRequest) => createKey(request),
  );
  ipcMain.handle("remote:keys:revoke", (_event, id: string) => {
    if (!instanceKeyStore().revoke(id)) {
      throw new Error("key not found");
    }
  });
}

function createKey(request: RemoteCreateKeyRequest): RemoteCreateKeyResult {
  const { record, token } = instanceKeyStore().create({
    name: typeof request?.name === "string" ? request.name : undefined,
    lifetimeSeconds:
      typeof request?.lifetimeSeconds === "number" &&
      request.lifetimeSeconds >= 0
        ? request.lifetimeSeconds
        : null,
    admin: request?.admin === true,
  });
  return { ...record, key: token };
}

/**
 * Answers "does this url/port/key actually talk to a weaver instance?" from
 * the Settings page. GET /v1/health is the cheapest probe: it is bearer-
 * protected, so a valid key is required to even get a 200, and it returns
 * nothing but who the key is. The verdict is always `{ ok, message }`; a
 * failed probe is still a successful check.
 */
async function checkRemote(host: string, port: number, key: string): Promise<RemoteCheckResult> {
  const base = remoteBaseUrl(host, port);
  if (!base) {
    return { ok: false, message: "needs a scheme and host", admin: false };
  }
  if (!key.trim()) {
    return { ok: false, message: "no key set", admin: false };
  }
  const upstream = await fetch(`${base}/v1/health`, {
    headers: { authorization: `Bearer ${key.trim()}` },
  }).catch((error: unknown) => {
    console.error(`remote check: fetch to ${base} failed:`, error);
    return null;
  });
  if (!upstream) {
    return { ok: false, message: `cannot reach ${base}`, admin: false };
  }
  const raw = await upstream.text();
  let admin = false;
  try {
    const payload = JSON.parse(raw) as { admin?: unknown };
    admin = payload.admin === true;
  } catch {
    // Non-JSON body; the status line below carries the verdict anyway.
  }
  if (!upstream.ok) {
    return {
      ok: false,
      message:
        upstream.status === 401 || upstream.status === 403
          ? "key rejected"
          : `HTTP ${upstream.status}`,
      admin: false,
    };
  }
  return {
    ok: true,
    message: admin ? "connection works (admin key)" : "connection works",
    admin,
  };
}

/**
 * Starts this machine's own server if the saved settings ask for it —
 * called once at app boot, before the window opens. Failure is logged, not
 * thrown; a broken setting must not stop the app from starting.
 */
export function startServerFromStoredSettings(): void {
  const config = readRemoteServerSettings();
  if (!config) return;
  void startRemoteInstance({ host: config.host, port: config.port }).then(
    (result) => {
      if (!result.ok) {
        console.error("remote server failed to start:", result.message);
      }
    },
  );
}