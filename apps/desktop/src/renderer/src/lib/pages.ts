/**
 * Every page the app can show, one entry per `<Route>` in `App.tsx`. This is
 * the single source a page is listed from: the shell's tab bar renders page
 * labels from it, and the `tab`/`space` popup lists it, so a new page only
 * needs an entry here plus its route to be reachable everywhere.
 */
export type Page = {
  /** Route id, used to key state (which tab holds which page). */
  id: string;
  /** Shown in the tab bar and in the `tab`/`space` popup. */
  label: string;
  /** The popup's shortcut letter — `c` chat, `r` resources, `s` settings. */
  key: string;
  /** Where the page lives; a tab pointed at it navigates here. */
  href: string;
};

export const PAGES: Page[] = [
  { id: "chat", label: "Chat", key: "c", href: "/chat" },
  { id: "resources", label: "Resources", key: "r", href: "/resources" },
  { id: "settings", label: "Settings", key: "s", href: "/settings" },
];
