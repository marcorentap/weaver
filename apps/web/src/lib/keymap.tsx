"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  keys: string[];
  /** Listed in the help popup. Omit to keep a binding undocumented. */
  help?: { keys: string; label: string };
  run: () => void;
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

  const push = useCallback((id: string) => {
    setStack((current) => [...current, id]);
    return () => setStack((current) => current.filter((entry) => entry !== id));
  }, []);

  useEffect(() => {
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

      // Innermost mode first; a modal layer stops the walk.
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const layer = layers.get(stack[i] as string);
        if (!layer) continue;
        const binding = layer.bindings.find((entry) =>
          entry.keys.includes(event.key),
        );
        if (binding) {
          event.preventDefault();
          binding.run();
          return;
        }
        if (layer.modal) return;
      }
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
