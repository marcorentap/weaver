import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

/**
 * Appearance and AI provider preferences, persisted under one key in the
 * main process's SQLite store via `window.api.settings`. Backed by a tiny
 * module store read through `useSyncExternalStore`, so hydration reads the
 * stored value once and re-renders through the external snapshot: no
 * setState-in-effect, no SSR mismatch (the server snapshot is always the
 * defaults).
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

/** Root font size, in px. Every rem-sized element scales off `<html>`. */
export const DEFAULT_FONT_SIZE = 15;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 20;

type Settings = {
  /** Left-hand gutter beside each chat block. */
  lineNumber: LineNumberMode;
  /** Whether preformatted content, code and a tool's output, wraps instead
   *  of scrolling sideways. */
  wordWrap: WordWrapMode;
  /** Root font size in px. Applied to `<html>`, so every rem-sized element
   *  scales with it. */
  fontSize: number;
  /** Default URL of an OpenAI-completions provider, e.g.
   *  "http://seer:4000/v1". An agent block appends "/chat/completions"
   *  itself. */
  aiEndpoint: string;
  /** Bearer token sent to `aiEndpoint`. */
  aiApiKey: string;
  /** Model id an agent block uses when its own `model` field is blank. */
  aiDefaultModel: string;
  /** Per-provider settings (routing preferences, and the like), keyed by
   *  the provider id `shared/provider-routing.ts` detects from
   *  `aiEndpoint`. Keyed rather than flat so switching endpoints between
   *  two known providers never clobbers the other one's saved values. */
  aiProviderSettings: Record<string, Record<string, string>>;
  /** What pi's `DefaultResourceLoader` loads on each agent run, inverted
   *  (`true` = don't load) so the names match the SDK flags the main
   *  process passes through. These are the app-wide defaults the `X` modal
   *  prefills per run. */
  noExtensions: boolean;
  noSkills: boolean;
  noPromptTemplates: boolean;
  noThemes: boolean;
  noContextFiles: boolean;
  /** Whether agent runs go through a remote weaver instance. */
  remoteEnabled: boolean;
  /** Scheme'd host of the remote instance, e.g. "http://192.168.1.20". */
  remoteHost: string;
  /** Port of the remote instance; ignored when `remoteHost` carries one. */
  remotePort: number;
  /** Key the remote instance issued. */
  remoteKey: string;
  /** Whether this machine's own server should be running (persisted so it
   *  comes back after a restart; toggle on/off controls it live). */
  remoteServerEnabled: boolean;
  /** Interface the server listens on, "0.0.0.0" for all. */
  remoteServerHost: string;
  remoteServerPort: number;
};

const STORAGE_KEY = "weaver.settings";

const DEFAULTS: Settings = {
  lineNumber: "absolute",
  wordWrap: "off",
  fontSize: DEFAULT_FONT_SIZE,
  aiEndpoint: "",
  aiApiKey: "",
  aiDefaultModel: "",
  aiProviderSettings: {},
  // Extensions, skills and context files are part of a block's context and
  // default on; pi's prompt templates and themes would change how
  // surrounding weaver chrome renders and stay off. Same defaults the main
  // process applies when a run omits a flag (`DISCOVERY_DEFAULTS`).
  noExtensions: false,
  noSkills: false,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: false,
  remoteEnabled: false,
  remoteHost: "",
  remotePort: 3111,
  remoteKey: "",
  remoteServerEnabled: false,
  remoteServerHost: "0.0.0.0",
  remoteServerPort: 3111,
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
 * The current settings outside a component, for plain functions called
 * during the render of something that already subscribes (a kind's `fields`,
 * called from chat's own render). Not reactive on its own. Callers that need
 * to re-render on a change must use `useSettings`.
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
  setFontSize: (size: number) => void;
  setAiEndpoint: (value: string) => void;
  setAiApiKey: (value: string) => void;
  setAiDefaultModel: (value: string) => void;
  setNoExtensions: (value: boolean) => void;
  setNoSkills: (value: boolean) => void;
  setNoPromptTemplates: (value: boolean) => void;
  setNoThemes: (value: boolean) => void;
  setNoContextFiles: (value: boolean) => void;
  setProviderField: (providerId: string, key: string, value: string) => void;
  setRemoteEnabled: (value: boolean) => void;
  setRemoteHost: (value: string) => void;
  setRemotePort: (value: number) => void;
  setRemoteKey: (value: string) => void;
  setRemoteServerEnabled: (value: boolean) => void;
  setRemoteServerHost: (value: string) => void;
  setRemoteServerPort: (value: number) => void;
};

const context = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { settings, hydrated } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  // Read the stored value once, after the server snapshot has been painted.
  // Defaults render first; `hydrated` flips once the IPC round trip
  // resolves.
  useEffect(() => {
    void (async () => {
      try {
        const raw = await window.api.settings.get(STORAGE_KEY);
        const stored = raw ? (JSON.parse(raw) as Partial<Settings>) : null;
        commit({
          settings: {
            lineNumber: stored?.lineNumber ?? DEFAULTS.lineNumber,
            wordWrap: stored?.wordWrap ?? DEFAULTS.wordWrap,
            fontSize: stored?.fontSize ?? DEFAULTS.fontSize,
            aiEndpoint: stored?.aiEndpoint ?? DEFAULTS.aiEndpoint,
            aiApiKey: stored?.aiApiKey ?? DEFAULTS.aiApiKey,
            aiDefaultModel: stored?.aiDefaultModel ?? DEFAULTS.aiDefaultModel,
            aiProviderSettings:
              stored?.aiProviderSettings ?? DEFAULTS.aiProviderSettings,
            noExtensions: stored?.noExtensions ?? DEFAULTS.noExtensions,
            noSkills: stored?.noSkills ?? DEFAULTS.noSkills,
            noPromptTemplates:
              stored?.noPromptTemplates ?? DEFAULTS.noPromptTemplates,
            noThemes: stored?.noThemes ?? DEFAULTS.noThemes,
            noContextFiles:
              stored?.noContextFiles ?? DEFAULTS.noContextFiles,
            remoteEnabled: stored?.remoteEnabled ?? DEFAULTS.remoteEnabled,
            remoteHost: stored?.remoteHost ?? DEFAULTS.remoteHost,
            remotePort: stored?.remotePort ?? DEFAULTS.remotePort,
            remoteKey: stored?.remoteKey ?? DEFAULTS.remoteKey,
            remoteServerEnabled:
              stored?.remoteServerEnabled ?? DEFAULTS.remoteServerEnabled,
            remoteServerHost:
              stored?.remoteServerHost ?? DEFAULTS.remoteServerHost,
            remoteServerPort:
              stored?.remoteServerPort ?? DEFAULTS.remoteServerPort,
          },
          hydrated: true,
        });
      } catch {
        // Corrupt stored JSON, or the main process unreachable. Keep
        // defaults, don't crash the shell.
        commit({ settings: DEFAULTS, hydrated: true });
      }
    })();
  }, []);

  // `<html>`'s font-size, not a component's own style, since every
  // rem-sized element in the app scales off the root, not just the ones
  // this provider wraps.
  useEffect(() => {
    document.documentElement.style.fontSize = `${settings.fontSize}px`;
  }, [settings.fontSize]);

  /** Every setter writes one field the same way: merge, commit, persist.
   *  Committed before the IPC round trip resolves, same optimistic order as
   *  every other mutation in the app, so a keystroke never waits on the
   *  main process to render. */
  const set = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    const next = { ...current.settings, [key]: value };
    commit({ settings: next, hydrated: current.hydrated });
    void window.api.settings.set(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const setLineNumber = useCallback(
    (lineNumber: LineNumberMode) => set("lineNumber", lineNumber),
    [set],
  );
  const setFontSize = useCallback((size: number) => set("fontSize", size), [set]);
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
  /** Merges one field into one provider's settings bag, leaving every
   *  other provider's saved values untouched. */
  const setProviderField = useCallback(
    (providerId: string, key: string, value: string) => {
      set("aiProviderSettings", {
        ...current.settings.aiProviderSettings,
        [providerId]: {
          ...current.settings.aiProviderSettings[providerId],
          [key]: value,
        },
      });
    },
    [set],
  );
  const setNoExtensions = useCallback(
    (value: boolean) => set("noExtensions", value),
    [set],
  );
  const setNoSkills = useCallback(
    (value: boolean) => set("noSkills", value),
    [set],
  );
  const setNoPromptTemplates = useCallback(
    (value: boolean) => set("noPromptTemplates", value),
    [set],
  );
  const setNoThemes = useCallback(
    (value: boolean) => set("noThemes", value),
    [set],
  );
  const setNoContextFiles = useCallback(
    (value: boolean) => set("noContextFiles", value),
    [set],
  );
  const setRemoteEnabled = useCallback(
    (value: boolean) => set("remoteEnabled", value),
    [set],
  );
  const setRemoteHost = useCallback(
    (value: string) => set("remoteHost", value),
    [set],
  );
  const setRemotePort = useCallback(
    (value: number) => set("remotePort", value),
    [set],
  );
  const setRemoteKey = useCallback(
    (value: string) => set("remoteKey", value),
    [set],
  );
  const setRemoteServerEnabled = useCallback(
    (value: boolean) => set("remoteServerEnabled", value),
    [set],
  );
  const setRemoteServerHost = useCallback(
    (value: string) => set("remoteServerHost", value),
    [set],
  );
  const setRemoteServerPort = useCallback(
    (value: number) => set("remoteServerPort", value),
    [set],
  );

  const value = useMemo(
    () => ({
      settings,
      hydrated,
      setLineNumber,
      setWordWrap,
      setFontSize,
      setAiEndpoint,
      setAiApiKey,
      setAiDefaultModel,
      setProviderField,
      setNoExtensions,
      setNoSkills,
      setNoPromptTemplates,
      setNoThemes,
      setNoContextFiles,
      setRemoteEnabled,
      setRemoteHost,
      setRemotePort,
      setRemoteKey,
      setRemoteServerEnabled,
      setRemoteServerHost,
      setRemoteServerPort,
    }),
    [
      settings,
      hydrated,
      setLineNumber,
      setWordWrap,
      setFontSize,
      setAiEndpoint,
      setAiApiKey,
      setAiDefaultModel,
      setProviderField,
      setNoExtensions,
      setNoSkills,
      setNoPromptTemplates,
      setNoThemes,
      setNoContextFiles,
      setRemoteEnabled,
      setRemoteHost,
      setRemotePort,
      setRemoteKey,
      setRemoteServerEnabled,
      setRemoteServerHost,
      setRemoteServerPort,
    ],
  );

  return <context.Provider value={value}>{children}</context.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(context);
  if (!value) throw new Error("useSettings must be used within SettingsProvider");
  return value;
}
