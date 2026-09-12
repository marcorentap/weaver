import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Persistent store of keys for this machine's remote instance.
 *
 * A key is a random bearer token shown exactly once, at creation, and stored
 * only as a salted SHA-256 hash — the file is the operator's root-guarded
 * `~/.weaver/remote-keys.json`, and even a hostile read of it must not hand
 * out usable tokens. A key either never expires (`expiresAt: null`) or does
 * at `expiresAt`; `revokedAt` kills it early. Either way, once gone, gone:
 * there is no un-revoke and no un-expire, because a token an operator thinks
 * is dead should be dead.
 */

/** Tokens carry this prefix so a leaked one is recognizable at a glance. */
export const REMOTE_KEY_PREFIX = "wrk_";

const TOKEN_BYTES = 32;

export type StoredRemoteKey = {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  admin: boolean;
  /** SHA-256 of the token, base64. The token itself is not stored. */
  hash: string;
};

/** A key as management UI sees it: never the hash, never the token. */
export type RemoteKeyView = Omit<StoredRemoteKey, "hash">;

/** Where keys live when the caller does not say otherwise. */
export function defaultKeysFile(): string {
  return join(homedir(), ".weaver", "remote-keys.json");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64");
}

export function newRemoteKeyToken(): string {
  return `${REMOTE_KEY_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type RemoteKeyStore = {
  file: string;
  list(): RemoteKeyView[];
  create(opts: {
    name?: string;
    lifetimeSeconds?: number | null;
    admin?: boolean;
  }): { record: RemoteKeyView; token: string };
  revoke(id: string): boolean;
  /** The key a token belongs to, or null for unknown/revoked/expired. */
  verify(token: string): StoredRemoteKey | null;
};

/** Loads (or creates, on first mutation) the store at `file`. */
export function loadRemoteKeyStore(file: string = defaultKeysFile()): RemoteKeyStore {
  let keys: StoredRemoteKey[] = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        keys = parsed.filter(
          (key): key is StoredRemoteKey =>
            typeof key === "object" &&
            key !== null &&
            typeof (key as StoredRemoteKey).id === "string",
        );
      }
    } catch {
      // Unreadable or corrupt: start empty rather than refuse to serve.
      keys = [];
    }
  }

  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(keys, null, 2));
    renameSync(tmp, file);
  };

  return {
    file,

    list: () =>
      keys.map((key) => ({
        id: key.id,
        name: key.name,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt,
        revokedAt: key.revokedAt,
        admin: key.admin,
      })),

    create({ name, lifetimeSeconds, admin }) {
      const createdAt = Date.now();
      const record: StoredRemoteKey = {
        id: randomUUID(),
        name: (name ?? "").trim() || `key-${keys.length + 1}`,
        createdAt,
        expiresAt:
          lifetimeSeconds && lifetimeSeconds > 0
            ? createdAt + lifetimeSeconds * 1000
            : null,
        revokedAt: null,
        admin: admin === true,
        hash: "",
      };
      const token = newRemoteKeyToken();
      record.hash = hashToken(token);
      keys.push(record);
      save();
      return {
        record: {
          id: record.id,
          name: record.name,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          revokedAt: record.revokedAt,
          admin: record.admin,
        },
        token,
      };
    },

    revoke(id) {
      const key = keys.find((candidate) => candidate.id === id);
      if (!key) return false;
      if (key.revokedAt === null) {
        key.revokedAt = Date.now();
        save();
      }
      return true;
    },

    verify(token) {
      if (!token.startsWith(REMOTE_KEY_PREFIX)) return null;
      const hash = hashToken(token);
      const key = keys.find((candidate) => sameHash(candidate.hash, hash));
      if (!key) return null;
      if (key.revokedAt !== null) return null;
      if (key.expiresAt !== null && key.expiresAt <= Date.now()) return null;
      return { ...key };
    },
  };
}