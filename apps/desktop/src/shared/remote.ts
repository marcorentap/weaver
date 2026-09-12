/**
 * Wire shapes for weaver's remote mode.
 *
 * A machine running weaver can act as a *server instance*: it exposes the
 * same agent runner the app already has, guarded by API keys. Another weaver
 * app points at it (URL, port, key) and its agent blocks run there — same
 * tools, but acting on the server's filesystem and project root instead of
 * the local one. The graphs and chat stay local; only inference moves.
 */

/** One key the local instance knows. The token and its hash are never
 *  exposed; this is everything management UI needs. */
export type RemoteKeySummary = {
  id: string;
  name: string;
  /** Unix ms at creation. */
  createdAt: number;
  /** Unix ms at expiry; null means the key never expires. */
  expiresAt: number | null;
  /** Unix ms at revocation; null means the key is still active. */
  revokedAt: number | null;
  /** An admin key can issue and revoke keys; a plain key can only run. */
  admin: boolean;
};

/** Create a key on the local instance. */
export type RemoteCreateKeyRequest = {
  name?: string;
  /** Validity in seconds; null/undefined means never expires. */
  lifetimeSeconds?: number | null;
  admin?: boolean;
};

/** A freshly created key. `key` is the token and is shown exactly once. */
export type RemoteCreateKeyResult = RemoteKeySummary & { key: string };

/** Verdict of poking `/v1/health` on a remote instance. */
export type RemoteCheckResult = {
  ok: boolean;
  message: string;
  /** True when the presented key is an admin key on that instance. */
  admin: boolean;
};

/** Result of starting/stopping this machine's own instance. */
export type RemoteInstanceResult = {
  ok: boolean;
  message: string;
};

/** Where this machine's own instance currently stands. */
export type RemoteInstanceStatus = {
  running: boolean;
  host: string;
  port: number | null;
  url: string | null;
};