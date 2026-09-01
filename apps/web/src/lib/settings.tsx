"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

/**
 * Appearance preferences, persisted in localStorage. Backed by a tiny module
 * store read through `useSyncExternalStore`, so hydration reads the stored
 * value once and re-renders through the external snapshot — no setState-in-
 * effect and no SSR mismatch (the server snapshot is always the defaults).
 */
export type LineNumberMode = "off" | "absolute" | "relative";

export const LINE_NUMBER_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "absolute", label: "Absolute" },
  { value: "relative", label: "Relative" },
] as const satisfies readonly { value: LineNumberMode; label: string }[];

type Settings = {
  /** Left-hand gutter beside each chat block. */
  lineNumber: LineNumberMode;
};

const STORAGE_KEY = "weaver.settings";

const DEFAULTS: Settings = { lineNumber: "absolute" };

/** Snapshot of everything the provider exposes; `hydrated` flips once the
 *  stored value has been read, so consumers never flash the wrong gutter. */
type Snapshot = { settings: Settings; hydrated: boolean };

const SERVER_SNAPSHOT: Snapshot = { settings: DEFAULTS, hydrated: false };
let current: Snapshot = { settings: DEFAULTS, hydrated: false };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Snapshot {
  return current;
}

function getServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

function commit(next: Snapshot) {
  current = next;
  emit();
}

type SettingsContextValue = {
  settings: Settings;
  hydrated: boolean;
  setLineNumber: (mode: LineNumberMode) => void;
};

const context = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { settings, hydrated } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  // Read the stored value once, after the server snapshot has been painted.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const stored = raw ? (JSON.parse(raw) as Partial<Settings>) : null;
      commit({
        settings: stored?.lineNumber
          ? { ...DEFAULTS, lineNumber: stored.lineNumber }
          : DEFAULTS,
        hydrated: true,
      });
    } catch {
      // Corrupt or unavailable storage: keep defaults, don't crash the shell.
      commit({ settings: DEFAULTS, hydrated: true });
    }
  }, []);

  const setLineNumber = useCallback((lineNumber: LineNumberMode) => {
    const next = { ...current.settings, lineNumber };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage can throw when full or off; the in-memory value stands.
    }
    commit({ settings: next, hydrated: current.hydrated });
  }, []);

  const value = useMemo(
    () => ({ settings, hydrated, setLineNumber }),
    [settings, hydrated, setLineNumber],
  );

  return <context.Provider value={value}>{children}</context.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(context);
  if (!value) throw new Error("useSettings must be used within SettingsProvider");
  return value;
}