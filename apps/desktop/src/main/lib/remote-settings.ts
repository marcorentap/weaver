import { getStore } from "./store.js";

/**
 * The persisted settings blob the renderer writes under `weaver.settings`
 * (see `renderer/src/lib/settings.tsx`). The main process reads only the
 * remote keys the agent proxy and the boot-time server need; everything else
 * in the blob is the renderer's concern.
 */
export const REMOTE_SETTINGS_KEY = "weaver.settings";

export type RemoteClientSettings = {
  enabled: boolean;
  /** Base URL of the instance, e.g. "http://192.168.1.20". */
  url: string;
  port: number;
  /** Key the instance issued. */
  key: string;
};

const DEFAULTS: RemoteClientSettings = {
  enabled: false,
  url: "",
  port: 3111,
  key: "",
};

/** The renderer's saved connection to a remote instance, defaults when it
 *  was never configured. */
export function readRemoteSettings(): RemoteClientSettings {
  try {
    const raw = getStore().getSetting(REMOTE_SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      enabled: parsed.remoteEnabled === true,
      url: typeof parsed.remoteHost === "string" ? parsed.remoteHost : "",
      port:
        typeof parsed.remotePort === "number" &&
        parsed.remotePort >= 1 &&
        parsed.remotePort <= 65535
          ? parsed.remotePort
          : DEFAULTS.port,
      key: typeof parsed.remoteKey === "string" ? parsed.remoteKey : "",
    };
  } catch {
    return DEFAULTS;
  }
}

/** Whether this machine's own server should be running on boot, from the
 *  same settings blob. */
export function readRemoteServerSettings(): { host: string; port: number } | null {
  try {
    const raw = getStore().getSetting(REMOTE_SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.remoteServerEnabled !== true) return null;
    const port =
      typeof parsed.remoteServerPort === "number" &&
      parsed.remoteServerPort >= 1 &&
      parsed.remoteServerPort <= 65535
        ? parsed.remoteServerPort
        : 3111;
    const host =
      typeof parsed.remoteServerHost === "string" &&
      parsed.remoteServerHost.trim()
        ? parsed.remoteServerHost.trim()
        : "0.0.0.0";
    return { host, port };
  } catch {
    return null;
  }
}

/**
 * The absolute base URL of a remote instance from its `host` (a scheme'd
 * host, the port column optional) and the settings `port`, or null when
 * `host` is not a usable URL. Only http(s) is accepted. A port written into
 * the host URL wins over the settings port.
 */
export function remoteBaseUrl(host: string, port: number): string | null {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  const effectivePort = url.port ? Number(url.port) : port;
  if (!Number.isInteger(effectivePort) || effectivePort < 1 || effectivePort > 65535) {
    return null;
  }
  return `${url.protocol}//${url.hostname}${url.pathname !== "/" ? url.pathname.replace(/\/+$/, "") : ""}:${effectivePort}`;
}