/**
 * Default title for a freshly created chat session: the current date and
 * time as a `YYYY-MM-DD HH:mm:ss` timestamp in local time, e.g.
 * `2025-07-16 14:03:02`. Every code path that mints a brand-new session
 * (the renderer's new-session actions and the main process's fallbacks for
 * sessions whose pending name was never set) uses this so a fresh session
 * is dated instead of generically named.
 */
export function newSessionTitle(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}