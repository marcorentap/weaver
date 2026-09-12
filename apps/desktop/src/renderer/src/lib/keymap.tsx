import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { KeyHelp } from "@/components/key-help";
import { keyComboName } from "@shared/keys.js";

export type KeyBinding = {
  /**
   * Matched against `KeyboardEvent.key`, so "Enter" and "s" both work. A
   * `ctrl+`-prefixed lowercase name ("ctrl+o") matches that key held with
   * ctrl or cmd, and an `alt+`-prefixed one ("alt+j") matches it held with
   * alt; unprefixed names never match a modified press.
   */
  keys?: string[];
  /**
   * A two-key sequence, `["Tab", "1"]` waiting for `Tab` then `1`, or
   * `["ctrl+w", "v"]` waiting for the modified key then a plain `v`, instead
   * of a single key. Both elements are named like a single binding: plain
   * keys by `event.key`, modified ones by their `ctrl+`- / `alt+`-prefixed
   * name, so `ctrl+w ctrl+w` is a valid second element too. A binding may
   * declare `chord`, `keys`, or both.
   */
  chord?: readonly [string, string];
  /** Listed in the help popup. Omit to keep a binding undocumented. */
  help?: { keys: string; label: string };
  /**
   * A leading digit run (`3` before `j`, `12` before `G`) is parsed and
   * passed here; absent when no count was typed.
   */
  run: (count?: number) => void;
};

export type KeyLayer = {
  /** Unique per mounted layer; also the mode name shown in help. */
  id: string;
  /**
   * Modal layers swallow keys they do not bind. Non-modal layers fall
   * through, which is how `tab` + digits and `[`/`]` keep switching tabs
   * while a page layer is active.
   */
  modal?: boolean;
  bindings: KeyBinding[];
  /**
   * Keys this layer documents but does not dispatch, because something else
   * owns them, like a text input, which the keymap deliberately ignores.
   */
  docs?: { keys: string; label: string }[];
  /**
   * The pane this layer belongs to, stamped by `useKeyLayer` when the
   * component sits under a `KeyFrameProvider`. A scoped layer dispatches
   * only while its pane is the one `KeymapProvider` was told has focus;
   * scope-less layers (chrome, normal mode) are always reachable.
   */
  scope?: string;
};

/** Reserved by the harness, so it works even inside a modal layer. */
export const HELP_KEY = "?";

type KeymapContext = {
  /**
   * Live layers, rewritten after every render of their owner. Bindings close
   * over component state, so dispatch must read the newest object rather
   * than one captured when the layer was pushed.
   */
  layers: Map<string, KeyLayer>;
  push: (id: string) => () => void;
  /** Same toggle the reserved help key runs, for anything clickable. */
  toggleHelp: () => void;
};

const context = createContext<KeymapContext | null>(null);

function useKeymapContext(): KeymapContext {
  const value = useContext(context);
  if (!value) throw new Error("keymap components require <KeymapProvider>");
  return value;
}

/**
 * Pane scoping. Every mounted pane registers the key layers of the page it
 * renders — a chat's chat mode, a settings form, a preview modal — under the
 * same flat ids. With two panes alive those ids would collide in the shared
 * registry and the last writer would own the keys of every pane showing that
 * page. A `KeyFrameProvider` scopes its whole subtree to the pane's id,
 * making each pane's layers distinct: the full id becomes `paneId::layerId`
 * and the layer carries the pane's `scope`.
 */
const scopeContext = createContext<string | null>(null);

/** Give a pane's subtree a key-scope. Every `useKeyLayer` below it is
 *  scoped to this pane id, so two panes can never share a layer id, and it
 *  dispatches only while this pane is the focused one. `KeymapProvider` is
 *  told the focused id as a prop, so "which pane may dispatch" is a plain
 *  value derived from the layout — not a side effect that can race a key. */
export function KeyFrameProvider({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  return <scopeContext.Provider value={id}>{children}</scopeContext.Provider>;
}

/** Open or close the help popup from outside the keymap. */
export function useToggleHelp(): () => void {
  return useKeymapContext().toggleHelp;
}

/** Typing in a field must never trigger a mode key. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function KeymapProvider({
  activePaneId,
  children,
}: {
  /**
   * The pane keyboard focus sits in, or null when nothing is focused (no
   * active tab). The layout owns this value; scoped layers dispatch only
   * while their scope equals it.
   */
  activePaneId: string | null;
  children: ReactNode;
}) {
  const [stack, setStack] = useState<string[]>([]);
  const [layers] = useState(() => new Map<string, KeyLayer>());
  const [helpOpen, setHelpOpen] = useState(false);

  // Vim-style count/chord state. Kept in refs, not state. They never affect
  // what's on screen, only how the next keydown is interpreted, so there is
  // nothing here worth a render.
  const pendingCount = useRef("");
  const pendingChord = useRef<string | null>(null);
  const countTimer = useRef<number | undefined>(undefined);
  const chordTimer = useRef<number | undefined>(undefined);

  const push = useCallback(
    (id: string) => {
      setStack((current) => [...current, id]);
      return () => setStack((current) => current.filter((entry) => entry !== id));
    },
    [],
  );

  useEffect(() => {
    function clearCount() {
      pendingCount.current = "";
      clearTimeout(countTimer.current);
      countTimer.current = undefined;
    }

    function clearChord() {
      pendingChord.current = null;
      clearTimeout(chordTimer.current);
      chordTimer.current = undefined;
    }

    // Innermost layer first; a modal layer swallows the key even when it
    // doesn't bind it, same as plain dispatch below. A scoped layer (a page
    // inside a pane) counts only while its pane is the focused one — a
    // hidden tab's panes can never match, because their ids differ.
    const scopeLive = (layer: KeyLayer) =>
      !layer.scope || layer.scope === activePaneId;

    function forEachReachableLayer(visit: (layer: KeyLayer) => boolean) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const layer = layers.get(stack[i] as string);
        if (!layer || !scopeLive(layer)) continue;
        if (visit(layer)) return;
        if (layer.modal) return;
      }
    }

    // The innermost modal layer, if any. Count prefixes are a
    // non-modal-mode feature, so their presence turns digits back into
    // ordinary keys, which a popup is then free to bind (a tab menu
    // offering "1".."9").
    function topModal(): KeyLayer | undefined {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const layer = layers.get(stack[i] as string);
        if (!layer || !scopeLive(layer)) continue;
        if (layer.modal) return layer;
      }
      return undefined;
    }

    // Modified-key dispatch, shared by the DOM keydown handler and the
    // forwarded leaders (Ctrl+W, swallowed in the main process so the
    // default Close accelerator can't kill the window, then sent here over
    // IPC). A modified key lands in one of three places, in this order:
    //
    // 1. as the follower of a pending chord (`ctrl+w ctrl+w` = next pane —
    //    a second modified leader only ever arrives this way; the page's
    //    own keydown is what the main process swallows);
    // 2. as the leader of a modified chord (`ctrl+w`), parked until its
    //    plain follower (`v`, `s`, `h`, …) arrives as a normal keydown;
    // 3. as a plain modified binding (`alt+h` resize, `ctrl+d` page-down).
    const dispatchModifiedCombo = (combo: string): boolean => {
      // A modified key arriving while a chord is pending resolves that
      // chord's follower (`ctrl+w ctrl+w` = next pane). A DOM keydown for
      // the only relevant modified leader (Ctrl+W) never reaches this
      // branch — the page doesn't see it at all — so `ctrl+w ctrl+w`
      // resolves here via the forwarded IPC event.
      if (pendingChord.current) {
        const leader = pendingChord.current;
        clearChord();
        let handled = false;
        if (combo !== "Escape") {
          forEachReachableLayer((layer) => {
            const binding = layer.bindings.find(
              (entry) =>
                entry.chord?.[0] === leader && entry.chord[1] === combo,
            );
            if (!binding) return false;
            binding.run();
            handled = true;
            return true;
          });
        }
        clearCount();
        return handled;
      }
      let leads = false;
      forEachReachableLayer((layer) => {
        if (!layer.bindings.some((entry) => entry.chord?.[0] === combo))
          return false;
        leads = true;
        return true;
      });
      if (leads) {
        pendingChord.current = combo;
        clearTimeout(chordTimer.current);
        chordTimer.current = window.setTimeout(clearChord, 1500);
        return true;
      }
      let handled = false;
      forEachReachableLayer((layer) => {
        const binding = layer.bindings.find((entry) =>
          entry.keys?.includes(combo),
        );
        if (!binding) return false;
        binding.run();
        handled = true;
        return true;
      });
      return handled;
    };

    function onKeyDown(event: KeyboardEvent) {
      if (isTextEntry(event.target)) return;

      // This key the way bindings name it: plain keys by their `event.key`,
      // modified ones by their `ctrl+`- / `alt+`-prefixed name. The main
      // process leaves a ctrl/cmd+alt pairing alone, and so does this — an
      // unclaimed browser shortcut keeps working.
      const combo = keyComboName(event.key, {
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
      });

      // A leader that consumed the previous keydown resolves against this
      // key, hit or miss, matched by the follower's own name (a plain `v`,
      // or a modified `ctrl+w`). A mistyped chord cancels instead of
      // falling through to an unrelated single-key binding.
      if (pendingChord.current) {
        const leader = pendingChord.current;
        clearChord();
        event.preventDefault();
        if (event.key !== "Escape" && combo) {
          forEachReachableLayer((layer) => {
            const binding = layer.bindings.find(
              (entry) =>
                entry.chord?.[0] === leader && entry.chord[1] === combo,
            );
            if (!binding) return false;
            binding.run();
            return true;
          });
        }
        clearCount();
        return;
      }

      // The help key is reserved, so a modal layer cannot hide the only way
      // of finding out which keys it binds.
      if (event.key === HELP_KEY) {
        event.preventDefault();
        setHelpOpen((open) => !open);
        return;
      }
      if (helpOpen) {
        event.preventDefault();
        if (event.key === "Escape") setHelpOpen(false);
        return;
      }

      // A modified key reaches only bindings that asked for it by name, and
      // skips counts and digits entirely. `3ctrl+o` is not a thing; an
      // unclaimed browser shortcut must keep working. All modified-key
      // dispatch — a `ctrl+w` leader parked for its follower, a
      // `ctrl+w ctrl+w` double-leader, `alt+h/j/k/l` resize — lives in
      // `dispatchModifiedCombo`, shared with the forwarded Ctrl+W leaders.
      if (event.ctrlKey || event.metaKey || event.altKey) {
        if (!combo) return;
        if (dispatchModifiedCombo(combo)) event.preventDefault();
        return;
      }

      // Digits build a count prefix for the next binding, vim-style. "3j"
      // moves three rows, "12G" jumps to line 12. A leading zero can't start
      // one, so it is free to be an ordinary binding. A modal popup stops
      // all that: it owns the digits it binds, and swallows the ones it
      // doesn't, like any other key.
      if (
        /^[0-9]$/.test(event.key) &&
        !(event.key === "0" && pendingCount.current === "") &&
        !topModal()
      ) {
        event.preventDefault();
        pendingCount.current += event.key;
        clearTimeout(countTimer.current);
        countTimer.current = window.setTimeout(clearCount, 1500);
        return;
      }

      // A key that leads some reachable chord waits for its second key
      // instead of dispatching as a plain binding.
      let leads = false;
      forEachReachableLayer((layer) => {
        if (!layer.bindings.some((entry) => entry.chord?.[0] === event.key))
          return false;
        leads = true;
        return true;
      });
      if (leads) {
        event.preventDefault();
        pendingChord.current = event.key;
        clearTimeout(chordTimer.current);
        chordTimer.current = window.setTimeout(clearChord, 1500);
        return;
      }

      let handled = false;
      forEachReachableLayer((layer) => {
        const binding = layer.bindings.find((entry) =>
          entry.keys?.includes(event.key),
        );
        if (!binding) return false;
        event.preventDefault();
        const count = pendingCount.current
          ? Number(pendingCount.current)
          : undefined;
        clearCount();
        binding.run(count);
        handled = true;
        return true;
      });
      if (!handled) clearCount();
    }

    // Ctrl+W and friends never reach the page's keydown — the main process
    // swallows them (so the default Close accelerator can't kill the window)
    // and forwards them here, keyed by the same `SWALLOWED_KEYS` table in
    // shared/keys.ts. Feed each through the same modified-key dispatch, with
    // the same guards as the keydown path (help open, or focus in a text
    // field, swallows it), so a leader can never arm a chord under a modal
    // or while typing.
    const removeForwardedKeys = window.api.keymap.onChordLeader((combo) => {
      if (helpOpen) return;
      if (isTextEntry(document.activeElement)) return;
      const handled = dispatchModifiedCombo(combo);
      // A swallowed key that no reachable layer bound the old design would
      // have suffered silently: the main process eats the key AND the
      // keymap has nothing to do with it, so the press just vanishes. Make
      // it loud — either SWALLOWED_KEYS was added without a binding, the
      // binding's layer unmounted, or a modal is standing in the way.
      if (!handled) {
        console.warn(
          `[keymap] swallowed key "${combo}" reached the page but no reachable layer binds it — check SWALLOWED_KEYS in shared/keys.ts`,
        );
      }
    });

    window.addEventListener("keydown", onKeyDown);
    return () => {
      removeForwardedKeys();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [stack, layers, helpOpen, activePaneId]);

  const toggleHelp = useCallback(() => setHelpOpen((open) => !open), []);

  const value = useMemo<KeymapContext>(
    () => ({ layers, push, toggleHelp }),
    [layers, push, toggleHelp],
  );

  // Only the layers a key can actually reach, matching dispatch, everything
  // from the innermost modal layer up. Scoped layers of non-focused panes
  // are skipped, so the popup shows only the pane under the cursor's modes.
  const reachable = stack
    .flatMap((id) => {
      const layer = layers.get(id);
      return layer && (!layer.scope || layer.scope === activePaneId)
        ? [layer]
        : [];
    })
    .reduce<KeyLayer[]>(
      (kept, layer) => (layer.modal ? [layer] : [...kept, layer]),
      [],
    );

  return (
    <context.Provider value={value}>
      {children}
      {helpOpen ? (
        <KeyHelp
          layers={reachable.map((layer) => ({
            id: layer.id,
            bindings: [
              ...layer.bindings.flatMap((binding) =>
                binding.help ? [binding.help] : [],
              ),
              ...(layer.docs ?? []),
            ],
          }))}
          onClose={() => setHelpOpen(false)}
        />
      ) : null}
    </context.Provider>
  );
}

/** Push `layer` for as long as the calling component is mounted. */
export function useKeyLayer(layer: KeyLayer): void {
  const { layers, push } = useKeymapContext();

  // Under a pane's `KeyFrameProvider`, scope the layer to that pane so its
  // id is unique app-wide and it dispatches only while that pane is the
  // active one (see `KeymapProvider`'s `activePaneId`).
  const scope = useContext(scopeContext);
  const fullId = scope ? `${scope}::${layer.id}` : layer.id;
  const scoped: KeyLayer = scope ? { ...layer, scope } : layer;

  // Runs on every render, before the push below on mount, so the layer is
  // always current by the time a key is dispatched to it.
  useEffect(() => {
    layers.set(fullId, scoped);
  });

  useEffect(() => {
    const pop = push(fullId);
    return () => {
      layers.delete(fullId);
      pop();
    };
  }, [layers, push, fullId]);
}