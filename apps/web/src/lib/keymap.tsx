"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { KeyHelp } from "@/components/key-help";

/**
 * Modal keyboard navigation. The UI is a stack of key layers, in the vim sense
 * of modes: the bottom layer is normal mode (global keys, always live), each
 * page pushes its own layer, and a dialog pushes a modal layer on top.
 *
 * A layer's lifetime is its component's lifetime, so a mode can never be left
 * dangling by a route change or an unmounted dialog.
 */
export type KeyBinding = {
  /** Matched against `KeyboardEvent.key`, so "Enter" and "s" both work. */
  keys?: string[];
  /**
   * A two-key sequence — `["Tab", "1"]` waits for `Tab` then `1` — instead of
   * a single key. A binding may declare `chord`, `keys`, or both.
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
   * Modal layers swallow keys they do not bind. Non-modal layers fall through,
   * which is how `1`/`2`/`3` keep switching tabs while a page layer is active.
   */
  modal?: boolean;
  bindings: KeyBinding[];
  /**
   * Keys this layer documents but does not dispatch, because something else
   * owns them — a text input, for instance, which the keymap deliberately
   * ignores.
   */
  docs?: { keys: string; label: string }[];
};

/** Reserved by the harness, so it works even inside a modal layer. */
export const HELP_KEY = "?";

type KeymapContext = {
  /**
   * Live layers, rewritten after every render of their owner. Bindings close
   * over component state, so dispatch must read the newest object rather than
   * one captured when the layer was pushed.
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

export function KeymapProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<string[]>([]);
  const [layers] = useState(() => new Map<string, KeyLayer>());
  const [helpOpen, setHelpOpen] = useState(false);

  // Vim-style count/chord state. Kept in refs, not state: they never affect
  // what's on screen, only how the next keydown is interpreted, so there is
  // nothing here worth a render.
  const pendingCount = useRef("");
  const pendingChord = useRef<string | null>(null);
  const countTimer = useRef<number | undefined>(undefined);
  const chordTimer = useRef<number | undefined>(undefined);

  const push = useCallback((id: string) => {
    setStack((current) => [...current, id]);
    return () => setStack((current) => current.filter((entry) => entry !== id));
  }, []);

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
    // doesn't bind it, same as plain dispatch below.
    function forEachReachableLayer(visit: (layer: KeyLayer) => boolean) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const layer = layers.get(stack[i] as string);
        if (!layer) continue;
        if (visit(layer)) return;
        if (layer.modal) return;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTextEntry(event.target)) return;

      // Help is reserved: a modal layer must not be able to hide the only way
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

      // A pending leader (e.g. `Tab`) resolves against exactly this key, hit
      // or miss — a mistyped chord cancels rather than falling through to an
      // unrelated single-key binding.
      if (pendingChord.current) {
        const leader = pendingChord.current;
        clearChord();
        event.preventDefault();
        if (event.key !== "Escape") {
          forEachReachableLayer((layer) => {
            const binding = layer.bindings.find(
              (entry) =>
                entry.chord?.[0] === leader && entry.chord[1] === event.key,
            );
            if (!binding) return false;
            binding.run();
            return true;
          });
        }
        clearCount();
        return;
      }

      // Digits build a count prefix for the next binding — "3j" moves three
      // rows, "12G" jumps to line 12 — vim-style. A leading zero can't start
      // one, so it is free to be an ordinary binding.
      if (
        /^[0-9]$/.test(event.key) &&
        !(event.key === "0" && pendingCount.current === "")
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

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stack, layers, helpOpen]);

  const toggleHelp = useCallback(() => setHelpOpen((open) => !open), []);

  const value = useMemo<KeymapContext>(
    () => ({ layers, push, toggleHelp }),
    [layers, push, toggleHelp],
  );

  // Only the layers a key can actually reach, matching dispatch: everything
  // from the innermost modal layer up.
  const reachable = stack
    .flatMap((id) => {
      const layer = layers.get(id);
      return layer ? [layer] : [];
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

  // Runs on every render, before the push below on mount, so the layer is
  // always current by the time a key is dispatched to it.
  useEffect(() => {
    layers.set(layer.id, layer);
  });

  useEffect(() => {
    const pop = push(layer.id);
    return () => {
      layers.delete(layer.id);
      pop();
    };
  }, [layers, push, layer.id]);
}
