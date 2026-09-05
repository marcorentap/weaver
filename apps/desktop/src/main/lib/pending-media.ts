/**
 * Media URIs a live agent run has asked to display but whose blocks are not
 * in the store yet.
 *
 * The `weaver-media://` protocol handler serves a URI only if a persisted
 * media block references it, or the file is inside the project — the two
 * safe things it can verify on its own. A block an agent just produced is
 * neither until the renderer's next autosave, so a fresh file it displays
 * (an output written to `/tmp`, say, outside the project) would otherwise
 * 403 on first load and, since a failed `<img>` never retries, stay broken
 * until a reload finally hits after persistence. This restores the instant
 * display by bridging exactly that gap: the display tool records what it is
 * about to show here, ahead of any request for it.
 *
 * Entries live for the process: they never grant more than what the agent
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