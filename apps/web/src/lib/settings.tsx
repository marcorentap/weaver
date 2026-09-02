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

export type WordWrapMode = "off" | "on";

export const WORD_WRAP_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: WordWrapMode; label: string }[];

type Settings = {
  /** Left-hand gutter beside each chat block. */
  lineNumber: LineNumberMode;
  /** Whether preformatted content — code, and a tool's output — wraps
   *  instead of scrolling sideways. */
  wordWrap: WordWrapMode;
  /** Base URL of an OpenAI-completions provider, e.g. "http://seer:4000/v1"
   *  — an agent block appends "/chat/completions" itself. */
  aiEndpoint: string;
  /** Bearer token sent to `aiEndpoint`. */
  aiApiKey: string;
  /** Model id an agent block uses when its own `model` field is blank. */
  aiDefaultModel: string;
};

const STORAGE_KEY = "weaver.settings";

const DEFAULTS: Settings = {
  lineNumber: "absolute",
  wordWrap: "off",
  aiEndpoint: "",
  aiApiKey: "",
  aiDefaultModel: "",
};

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

/**
 * The current settings outside a component — for plain functions called
 * during the render of something that already subscribes (a kind's `fields`,
 * called from chat's own render). Not reactive on its own: a caller that
 * needs to re-render on a change must use `useSettings`.
 */
export function readSettings(): Settings {
  return current.settings;
}

function commit(next: Snapshot) {
  current = next;
  emit();
}

type SettingsContextValue = {
  settings: Settings;
  hydrated: boolean;
  setLineNumber: (mode: LineNumberMode) => void;
  setWordWrap: (mode: WordWrapMode) => void;
  setAiEndpoint: (value: string) => void;
  setAiApiKey: (value: string) => void;
  setAiDefaultModel: (value: string) => void;
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
        settings: {
          lineNumber: stored?.lineNumber ?? DEFAULTS.lineNumber,
          wordWrap: stored?.wordWrap ?? DEFAULTS.wordWrap,
          aiEndpoint: stored?.aiEndpoint ?? DEFAULTS.aiEndpoint,
          aiApiKey: stored?.aiApiKey ?? DEFAULTS.aiApiKey,
          aiDefaultModel: stored?.aiDefaultModel ?? DEFAULTS.aiDefaultModel,
        },
        hydrated: true,
      });
    } catch {
      // Corrupt or unavailable storage: keep defaults, don't crash the shell.
      commit({ settings: DEFAULTS, hydrated: true });
    }
  }, []);

  /** Every setter writes one field the same way: merge, persist, commit. */
  const set = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    const next = { ...current.settings, [key]: value };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage can throw when full or off; the in-memory value stands.
    }
    commit({ settings: next, hydrated: current.hydrated });
  }, []);

  const setLineNumber = useCallback(
    (lineNumber: LineNumberMode) => set("lineNumber", lineNumber),
    [set],
  );
  const setWordWrap = useCallback(
    (wordWrap: WordWrapMode) => set("wordWrap", wordWrap),
    [set],
  );
  const setAiEndpoint = useCallback(
    (value: string) => set("aiEndpoint", value),
    [set],
  );
  const setAiApiKey = useCallback(
    (value: string) => set("aiApiKey", value),
    [set],
  );
  const setAiDefaultModel = useCallback(
    (value: string) => set("aiDefaultModel", value),
    [set],
  );

  const value = useMemo(
    () => ({
      settings,
      hydrated,
      setLineNumber,
      setWordWrap,
      setAiEndpoint,
      setAiApiKey,
      setAiDefaultModel,
    }),
    [
      settings,
      hydrated,
      setLineNumber,
      setWordWrap,
      setAiEndpoint,
      setAiApiKey,
      setAiDefaultModel,
    ],
  );

  return <context.Provider value={value}>{children}</context.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(context);
  if (!value) throw new Error("useSettings must be used within SettingsProvider");
  return value;
}