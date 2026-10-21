import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where files the app produces on a person's behalf land, one directory per
 * session: `~/.weaver/artifacts/<session id>/<uuid>.<ext>`. Kept in the app's
 * own home, where the default store also lives, rather than in the project,
 * because these are the app's own copies — a pasted screenshot belongs to the
 * conversation, not to whatever directory that conversation happens to be
 * working in, and writing it into the project would put bytes there nobody
 * asked to commit.
 *
 * A session's folder outlives the session. Deleting a session deletes its
 * blocks, and with them the only references to these files, but the files
 * themselves are left alone: a block can name one from a duplicated session,
 * and silently removing a person's pasted images is worse than a directory
 * that grows.
 */
export const ARTIFACTS_DIR = join(homedir(), ".weaver", "artifacts");

/** Session ids are store-minted UUIDs, but this value still arrives from the
 *  renderer, so it is checked before it is joined into a path: a session id
 *  that walks (`../..`) would write outside the artifacts directory. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function sessionArtifactsDir(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) {
    throw new Error(`not a session id: ${sessionId}`);
  }
  return join(ARTIFACTS_DIR, sessionId);
}

/**
 * Writes `bytes` into the session's artifacts directory under a fresh name
 * and returns the absolute path, which is what a media block's `uri` holds.
 * The name is a UUID so two pastes of the same screenshot cannot collide,
 * and the extension comes from the caller because it is what makes the
 * media protocol serve the file as the kind of thing it is — an extensionless
 * artifact would render as "no viewer for this file".
 */
export async function writeSessionArtifact(
  sessionId: string,
  bytes: Uint8Array,
  extension: string,
): Promise<string> {
  const dir = sessionArtifactsDir(sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${extension}`);
  await writeFile(path, bytes);
  return path;
}
