/**
 * The one recipe for how a hardware key becomes a "combo" name, and the one
 * place that says which keys the main process may swallow.
 *
 * Why this module exists: Ctrl+W is the whole app's close shortcut, so the
 * main process has to intercept it before it reaches the menu — but the
 * keymap in the renderer binds it as a chord leader. If the two sides each
 * chose their own spelling (the interceptor hardcoding `"w"`, the keymap
 * declaring `"ctrl+w"`), a key could be eaten on one side and bound on the
 * other with nobody noticing — the exact failure that made `ctrl+w v/s/h/...`
 * dead on arrival the first time around.
 *
 * So the naming function and the swallow list both live here, in one shared
 * module that main, preload and renderer all import. The main process gets
 * its interception from `swallowedCombo`; the keymap gets the same string
 * from `keyComboName`. Anything that keeps the two apart — a swallow that
 * isn't forwarded, a forward that doesn't swallow, a name that doesn't
 * match — has to be introduced in this file on purpose, not stumbled into.
 */

/**
 * The canonical name for one key, the exact string key bindings match:
 * plain keys by their `event.key` (`"v"`, `"s"`, `"q"`), modified ones by
 * their `ctrl+`- or `alt+`-prefixed lowercase name (`"ctrl+w"`, `"alt+h"`).
 * Ctrl and cmd are the same key. `null` for pairings the keymap never
 * claims (ctrl/cmd + alt), which are left to the browser.
 */
export function keyComboName(
  key: string,
  mods: { ctrl: boolean; meta: boolean; alt: boolean },
): string | null {
  if (mods.ctrl || mods.meta) {
    if (mods.alt) return null;
    return `ctrl+${key.toLowerCase()}`;
  }
  if (mods.alt) return `alt+${key.toLowerCase()}`;
  return key;
}

/**
 * Every key the main process intercepts before it can reach the page — and,
 * because it intercepts it, MUST forward to the renderer over
 * `CHORD_LEADER_CHANNEL`, or the key would be dead on the renderer side
 * while the keymap still binds it. The value records what would otherwise
 * eat the key, so it is self-documenting why the interception exists.
 *
 * The rule that keeps this safe: the main process preventDefaults ONLY keys
 * in this map and forwards each one in the same stroke. A key here with no
 * renderer binding is a harmless no-op (the forward is discarded); a key
 * bound in the renderer that the main process swallows but that is NOT here
 * is the failure this module exists to make impossible.
 */
export const SWALLOWED_KEYS: Readonly<Record<string, string>> = {
  "ctrl+w":
    "the default Close accelerator (menu role + Chromium's close-tab) would kill the app mid-session; the keymap binds it as its window/pane chord leader",
};

/** The IPC channel a swallowed key is forwarded over, named in one place so
 *  main and renderer can't drift apart on the wire. */
export const CHORD_LEADER_CHANNEL = "keymap:chord-leader";

/**
 * Whether a `before-input-event` payload is one of the shell's swallowed
 * keys, returning the canonical combo name to forward (or null to let the
 * key flow normally). Today the shell swallows only the bare Ctrl+letter
 * shape — no meta/alt/shift held — so Ctrl+Shift+W, say, keeps flowing to
 * the page where it lands in the keymap as the same `"ctrl+w"` combo via
 * the DOM path. If a future key needs a different modifier shape, grow the
 * match here, never in main/index.ts, so "prevented and forwarded
 * together" stays true in exactly one place.
 */
export function swallowedCombo(input: {
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}): string | null {
  if (!input.control || input.meta || input.alt || input.shift) return null;
  const name = keyComboName(input.key, {
    ctrl: true,
    meta: false,
    alt: false,
  });
  return name && name in SWALLOWED_KEYS ? name : null;
}