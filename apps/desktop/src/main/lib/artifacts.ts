import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

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

/**
 * How large a file may be before adopting it is refused. The copy is the
 * whole of the cost: a dropped 4 GB video would stall the app for minutes
 * with nothing on screen to say why, and the artifact could not be previewed
 * in any case. Refusing with a message is the better failure.
 */
const ADOPT_LIMIT = 512 * 1024 * 1024;

/** The extension a copied file keeps: its own, when it has a sane one. An
 *  extension is what makes the media protocol serve the copy as the kind of
 *  thing it is, so it is taken from the file's own name rather than guessed
 *  from its bytes. A name with nothing usable after the dot gets `bin`, which
 *  the media kind renders as an unknown file — honest about not knowing what
 *  it is, and still a block one can point a run at. */
function artifactExtension(name: string): string {
  const ext = extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : "bin";
}

/**
 * Takes an outside file — one dragged in from a file manager — into the
 * session's artifacts directory and returns the copy's absolute path, which
 * is what a media block's `uri` holds.
 *
 * The file is copied rather than referenced. A drag is a person saying "this
 * belongs to the conversation", and the original may be moved, renamed or
 * empty itself out from under a block that merely pointed at it. A copy also
 * keeps the media protocol's job simple: the source could be anywhere on the
 * disk, while an artifact is a file the app made and can vouch for.
 */
export async function adoptSessionArtifact(
  sessionId: string,
  source: string,
): Promise<string> {
  const info = await stat(source);
  if (!info.isFile()) throw new Error(`not a file: ${source}`);
  if (info.size > ADOPT_LIMIT) {
    const limit = ADOPT_LIMIT / 1024 / 1024;
    throw new Error(`too large to copy in (over ${limit} MB)`);
  }
  const dir = sessionArtifactsDir(sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${artifactExtension(source)}`);
  await copyFile(source, path);
  return path;
}
