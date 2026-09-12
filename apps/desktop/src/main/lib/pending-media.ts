/**
 * Media URIs a live agent run has asked to show but whose blocks are not
 * in the store yet.
 *
 * The `weaver-media://` protocol handler serves a URI only when a persisted
 * media block references it or the file is inside the project, the two
 * things it can verify on its own. A block an agent just produced is
 * neither until the renderer's next autosave, so a fresh file it shows
 * (an output written to `/tmp`, say, outside the project) would 403 on the
 * first load. A failed `<img>` never retries, so it stays broken until a
 * reload lands after persistence. The `display_media` tool records what it
 * is about to show here, ahead of any request for it, which covers exactly
 * that gap.
 *
 * Entries live for the process. They never grant more than what the agent
 * already chose to show, and once the block autosaves the store reference
 * covers the URI anyway, so dropping them on a later save would add races
 * for no security gain. The set is empty again on the next launch.
 */
const pending = new Set<string>();

export function registerPendingMedia(uri: string): void {
  pending.add(uri);
}

export function isPendingMedia(uri: string): boolean {
  return pending.has(uri);
}

/** Every URI a live agent run has asked to show so far, for the protocol
 *  handler's own resolution matching (a stored block's relative path, say,
 *  asks for it by its absolute form). */
export function pendingMediaUris(): string[] {
  return [...pending];
}