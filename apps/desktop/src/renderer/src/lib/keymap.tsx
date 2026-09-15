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

export type HelpBinding = { keys: string; label: string };

export type KeyBinding = {
  /**
   * Matched against `KeyboardEvent.key`, so "Enter" and "s" both work. A
   * `ctrl+`-prefixed lowercase name ("ctrl+o") matches that key held with
   * ctrl or cmd, and an `alt+`-prefixed one ("alt+j") matches it held with
   * alt; unprefixed names never match a modified press.
   */
  keys?: string[];
  /**
   * Listed in the help popup, one row per entry. A leader that pushes a
   * `layer` documents every follower it reaches here ("ctrl+w v", "gg"),
   * because the followers live in the transient frame — out of reach of the
   * help popup until the leader is pressed. Omit to keep a binding
   * undocumented.
   */
  help?: HelpBinding[];
  /**
   * Pressing this key runs `run`, then pushes `layer` onto the keymap stack
   * as a transient frame: the keys that follow dispatch against that layer
   * until one of its bindings fires (popping the frame unless it is
   * `repeatable`), a key it does not bind arrives (cancelling it), or
   * Escape cancels it. This is the layer-push that replaces the old fixed
   * two-key chord. `s > t` — "s runs a function AND puts a layer with t on
   * top" — is a single binding:
   *
   *     { keys: ["s"], run: onS, layer: { id: "s", bindings: [
   *         { keys: ["t"], run: onT },
   *       ] } }
   *
   * Frames nest to any depth (s > t > u), each follower layer resolving back
   * to the one below when its binding fires. The layer in `layer:` is a live
   * object, so its bindings may close over current component state if the
   * binding is rebuilt on render.
   */
  layer?: KeyLayer;
  /**
   * A binding living inside a `layer` that, once hit, keeps that layer
   * pushed so re-pressing the same follower repeats without a fresh leader
   * (`ctrl+w alt+h` then `alt+h` keeps adding 10px). Followers without it
   * pop their frame after the first hit, so `ctrl+w h` moves focus once and
   * the frame is gone. Auto-repeat holds count for exactly one action either
   * way.
   */
  repeatable?: boolean;
  /**
   * The action. Optional only for a leader paired with `layer` that just
   * opens a frame (the `g` of `gg`); every other binding runs something. A
   * leading digit run (`3` before `j`, `12` before `G`) is parsed and passed
   * here; absent when no count was typed. Only plain single-key bindings
   * take a count — followers and modified keys never do.
   */
  run?: (count?: number) => void;
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
  docs?: HelpBinding[];
  /**
   * The pane this layer belongs to, stamped by `useKeyLayer` when the
   * component sits under a `KeyFrameProvider`. A scoped layer dispatches
   * only while its pane is the one `KeymapProvider` was told has focus;
   * scope-less layers (chrome, normal mode) are always reachable. Keypress-
   * pushed frames inherit their source layer's scope.
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

/**
 * One entry on the layer stack. `transient` frames are pushed by a keypress
 * (a binding's `layer`) and resolve-and-pop like the old chords; persistent
 * entries are declarative `useKeyLayer` layers that stay until unmounted.
 */
type StackEntry = { id: string; transient: boolean };

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
  const [stack, setStack] = useState<StackEntry[]>([]);
  const [layers] = useState(() => new Map<string, KeyLayer>());
  const [helpOpen, setHelpOpen] = useState(false);

  // Vim-style count state, plus the transient-frame machinery. All kept in
  // refs or imperative map writes, not state. Count never affects what's on
  // screen; transient frames are entries in `stack`/`layers` only for the
  // very next keydown, so there is nothing here worth a render in itself.
  const pendingCount = useRef("");
  const countTimer = useRef<number | undefined>(undefined);
  const frameTimer = useRef<number | undefined>(undefined);
  /** Registered ids of every live transient frame, so a timeout or cancel
   *  can drop them without trusting a possibly-stale `stack` closure. */
  const frameKeys = useRef(new Set<string>());
  const seq = useRef(0);

  const push = useCallback((id: string) => {
    setStack((current) => [...current, { id, transient: false }]);
    return () =>
      setStack((current) =>
        current.filter((entry) => entry.id !== id),
      );
  }, []);

  useEffect(() => {
    function clearCount() {
      pendingCount.current = "";
      clearTimeout(countTimer.current);
      countTimer.current = undefined;
    }

    function clearFrames() {
      clearTimeout(frameTimer.current);
      frameTimer.current = undefined;
      frameKeys.current.forEach((id) => layers.delete(id));
      frameKeys.current.clear();
      setStack((current) => current.filter((entry) => !entry.transient));
    }

    // Innermost reachable stack index: the layer the next key dispatches to.
    // A scoped layer (a page inside a pane) counts only while its pane is
    // the focused one — a hidden tab's panes can never match, because their
    // ids differ.
    const scopeLive = (layer: KeyLayer) =>
      !layer.scope || layer.scope === activePaneId;

    function topReachableIndex(): number {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const layer = layers.get(stack[i]!.id);
        if (layer && scopeLive(layer)) return i;
      }
      return -1;
    }

    // A digit is a count prefix only when no modal layer is live, and a
    // transient frame on top already intercepted it (see `onKeyDown`), so
    // only persistent modals matter here.
    function topModalExists(): boolean {
      return stack.some((entry) => {
        if (entry.transient) return false;
        const layer = layers.get(entry.id);
        return !!layer && layer.modal && scopeLive(layer);
      });
    }

    // The topmost reachable transient frame's index, or -1 for none.
    function topFrameIndex(): number {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const entry = stack[i]!;
        const layer = layers.get(entry.id);
        if (layer && entry.transient && scopeLive(layer)) return i;
      }
      return -1;
    }

    /** Pop the topmost reachable transient frame (cancel that level of a
     *  pending chord), and rest the timeout for whatever frame is left. */
    function popTopFrame(): boolean {
      const i = topFrameIndex();
      if (i === -1) return false;
      const id = stack[i]!.id;
      layers.delete(id);
      frameKeys.current.delete(id);
      setStack((current) => current.filter((_, idx) => idx !== i));
      // The closure `stack` still lists the frame we just popped; what
      // remains are the frames that are genuinely still on the stack.
      const remaining = stack.filter((entry) => entry.transient).length - 1;
      clearTimeout(frameTimer.current);
      if (remaining > 0) {
        frameTimer.current = window.setTimeout(clearFrames, 1500);
      } else {
        frameTimer.current = undefined;
      }
      return true;
    }

    /** Register `target` as a transient frame on top of the stack, scoped to
     *  the layer that pushed it, and arm its 1500ms expiry. */
    function pushFrame(target: KeyLayer, scope: string | undefined) {
      const key = `${target.id}\u0000frame${seq.current}`;
      seq.current += 1;
      const frame: KeyLayer = scope ? { ...target, scope } : { ...target };
      layers.set(key, frame);
      frameKeys.current.add(key);
      setStack((current) => [...current, { id: key, transient: true }]);
      clearTimeout(frameTimer.current);
      frameTimer.current = window.setTimeout(clearFrames, 1500);
    }

    /**
     * Resolve a key against the transient frame on top, reached when the
     * caller has already established that a frame is the innermost reachable
     * layer. A hit runs the follower binding, either pushing a deeper frame
     * (s > t > u), staying armed for a `repeatable` follower, or popping
     * back to the layer below. A miss pops the frame and swallows the key —
     * exactly the old "a missed follower cancels the chord instead of
     * falling through" rule.
     */
    function resolveFrame(combo: string): boolean {
      const i = topFrameIndex();
      if (i === -1) return false;
      const layer = layers.get(stack[i]!.id)!;
      clearCount();
      if (combo === "Escape") {
        popTopFrame();
        return true;
      }
      const binding = layer.bindings.find((entry) =>
        entry.keys?.includes(combo),
      );
      if (binding) {
        if (binding.layer) {
          binding.run?.(undefined);
          pushFrame(binding.layer, layer.scope);
        } else {
          binding.run?.(undefined);
          if (binding.repeatable) {
            clearTimeout(frameTimer.current);
            frameTimer.current = window.setTimeout(clearFrames, 1500);
          } else {
            popTopFrame();
          }
        }
        return true;
      }
      popTopFrame();
      return true;
    }

    /**
     * Dispatches `combo` against the layer stack, innermost first. Used for
     * plain single keys (`countable`), modified combos, and forwarded
     * swallowed leaders alike. A modal layer swallows keys it does not bind;
     * a transient frame miss pops it and swallows the key; non-modal layers
     * fall through.
     */
    function handleCombo(
      combo: string,
      opts: { countable: boolean },
    ): boolean {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const entry = stack[i]!;
        const layer = layers.get(entry.id);
        if (!layer || !scopeLive(layer)) continue;
        const binding = layer.bindings.find((candidate) =>
          candidate.keys?.includes(combo),
        );
        if (binding) {
          if (binding.layer) {
            // A leader: run its function, then push the follower frame. The
            // count never feeds a leader — `g` in `gg` is a prefix, not an
            // action, so any typed digits are consumed by it.
            clearCount();
            binding.run?.(undefined);
            pushFrame(binding.layer, layer.scope);
          } else if (opts.countable) {
            const count = pendingCount.current
              ? Number(pendingCount.current)
              : undefined;
            clearCount();
            binding.run?.(count);
          } else {
            clearCount();
            binding.run?.(undefined);
          }
          return true;
        }
        if (entry.transient) {
          // Unbound key in a keypress-pushed frame: cancel it, swallow it.
          popTopFrame();
          return true;
        }
        if (layer.modal) return false;
      }
      return false;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (isTextEntry(event.target)) return;

      // The bare modifier keypress (the `Alt` of `alt+h`, the `Shift` of
      // `shift+j`) is never a follower and must not cancel a parked frame:
      // without this, `ctrl+w` then `alt+h` would cancel the pane frame on
      // the `Alt` keydown and the `h` would land against nothing.
      if (/^(Alt|Control|Meta|Shift|CapsLock|NumLock|Fn|OS|Super)$/i.test(event.key)) {
        return;
      }

      // A transient frame on top resolves the very next key, hit or miss,
      // exactly as a pending chord did. The follower names itself with the
      // leader's own ctrl/cmd stripped — the leader is still held, so the
      // DOM reports `ctrl+h` for a `ctrl+w` + `h` and a `ctrl+alt+h` pairing
      // for `ctrl+w` + `alt+h`, while the frame binds `alt+h`. Auto-repeat
      // keydowns (a held follower) are ignored — they neither re-run the
      // binding nor cancel the frame — so holding produces one action.
      // `Escape` is a miss that only cancels the frame, never anything below.
      const top = topReachableIndex();
      if (top !== -1 && stack[top]!.transient) {
        event.preventDefault();
        if (event.repeat) return;
        const combo =
          event.key === "Escape"
            ? "Escape"
            : keyComboName(event.key, {
                ctrl: false,
                meta: false,
                alt: event.altKey,
              });
        if (combo) resolveFrame(combo);
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

      // This key the way bindings name it: plain keys by their `event.key`,
      // modified ones by their `ctrl+`- / `alt+`-prefixed name. The main
      // process leaves a ctrl/cmd+alt pairing alone, and so does this — an
      // unclaimed browser shortcut keeps working.
      const combo = keyComboName(event.key, {
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
      });

      // A modified key reaches only bindings that asked for it by name, and
      // skips counts and digits entirely. `3ctrl+o` is not a thing; an
      // unclaimed browser shortcut must keep working. Modified dispatch —
      // a `ctrl+w` leader parking its pane frame, a plain `ctrl+d` page-down
      // — lives here, shared with the forwarded Ctrl+W leaders.
      if (event.ctrlKey || event.metaKey || event.altKey) {
        if (!combo) return;
        if (handleCombo(combo, { countable: false })) event.preventDefault();
        return;
      }

      // Digits build a count prefix for the next binding, vim-style. "3j"
      // moves three rows, "12G" jumps to line 12. A leading zero can't start
      // one, so it is free to be an ordinary binding. A modal popup stops
      // all that: it owns the digits it binds, and swallows the ones it
      // doesn't, like any other key. (A transient frame already consumed the
      // digit above, before this branch.)
      if (
        /^[0-9]$/.test(event.key) &&
        !(event.key === "0" && pendingCount.current === "") &&
        !topModalExists()
      ) {
        event.preventDefault();
        pendingCount.current += event.key;
        clearTimeout(countTimer.current);
        countTimer.current = window.setTimeout(clearCount, 1500);
        return;
      }

      if (handleCombo(event.key, { countable: true })) event.preventDefault();
      else clearCount();
    }

    // Ctrl+W and friends never reach the page's keydown — the main process
    // swallows them (so the default Close accelerator can't kill the window)
    // and forwards them here, keyed by the same `SWALLOWED_KEYS` table in
    // shared/keys.ts. Feed each through the same dispatch as a keydown, with
    // the same guards (help open, or focus in a text field, swallows it), so
    // a leader can never push a frame under a modal or while typing. A
    // second swallowed `ctrl+w` while the pane frame is parked resolves its
    // own follower (`ctrl+w ctrl+w` = next pane).
    const removeForwardedKeys = window.api.keymap.onChordLeader((combo) => {
      if (helpOpen) return;
      if (isTextEntry(document.activeElement)) return;
      const top = topReachableIndex();
      const handled =
        top !== -1 && stack[top]!.transient
          ? resolveFrame(combo)
          : handleCombo(combo, { countable: false });
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
  // Keypress-pushed frames are on the stack too; they surface nothing, since
  // their followers are undocumented (the leader documents them), so empty
  // sections are dropped.
  const reachable = stack
    .flatMap((entry) => {
      const layer = layers.get(entry.id);
      return layer && (!layer.scope || layer.scope === activePaneId)
        ? [layer]
        : [];
    })
    .reduce<KeyLayer[]>(
      (kept, layer) => (layer.modal ? [layer] : [...kept, layer]),
      [],
    )
    .filter(
      (layer) =>
        layer.bindings.some((binding) => binding.help?.length) ||
        (layer.docs && layer.docs.length > 0),
    );

  return (
    <context.Provider value={value}>
      {children}
      {helpOpen ? (
        <KeyHelp
          layers={reachable.map((layer) => ({
            id: layer.id,
            bindings: [
              ...layer.bindings.flatMap((binding) => binding.help ?? []),
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