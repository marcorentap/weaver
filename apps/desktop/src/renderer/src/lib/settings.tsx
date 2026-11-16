import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { z } from "zod";

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

/** The on/off choice the boolean toggles offer — the discovery rows in the
 *  settings page and their mirror in the `X` dialog. One definition, so the
 *  two cannot drift apart in order or labels the way they had. */
export const ON_OFF_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const;

/**
 * The reasoning-effort choices the "Inference settings" and
 * "Summarization settings" sections (and the `X` / `S` dialogs) offer:
 * pi-ai's own levels plus a blank "Default" that leaves the SDK's
 * default in charge. The non-blank values are the wire layer's
 * `THINKING_LEVELS` (`shared/agent-events.ts`); this list only wraps them
 * in display labels.
 */
export const THINKING_LEVEL_OPTIONS = [
  { value: "", label: "Default" },
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
] as const;

/** Root font size, in px. Every rem-sized element scales off `<html>`. */
export const DEFAULT_FONT_SIZE = 15;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 20;

/**
 * One settings field, wrapped so a missing or unreadable stored value falls
 * back to `fallback` without taking the rest of the settings down with it.
 * `.catch` covers both cases a stored blob can present: a key absent from an
 * older blob (undefined fails the schema) and a wrong-typed value (a
 * hand-edited store, a field whose type changed since it was written). Being
 * per field, one corrupt value resets only itself rather than the whole
 * object.
 */
function field<T extends z.ZodTypeAny>(
  schema: T,
  fallback: z.output<T>,
): z.ZodCatch<T> {
  return schema.catch(fallback);
}

/**
 * One MCP server as the settings page keeps it: a form, not a connection.
 *
 * The page's rows are one value each, so a server is a flat record of text —
 * a command line rather than an executable and an argv, headers as the lines
 * a person writes rather than a map — and `renderer/lib/mcp.ts` turns it into
 * the shape a run mounts. Each field carries its own fallback, so a server
 * added before a field existed still reads as a complete server.
 */
export const mcpServerSettings = z.object({
  /** A local process, spawned by the app, or a remote endpoint. */
  transport: z.enum(["stdio", "http"]).catch("stdio"),
  /** stdio: the whole command line, e.g. `npx -y some-mcp-server /tmp`.
   *  Never run through a shell; see `splitCommandLine` in `shared/mcp.ts`. */
  command: z.string().catch(""),
  /** http: the endpoint's URL. */
  url: z.string().catch(""),
  /** http: extra request headers, one `Name: value` per line. */
  headers: z.string().catch(""),
  /** Whether a run mounts this server by default. A custom run can turn an
   *  enabled one off for itself without editing the setting. */
  enabled: z.boolean().catch(true),
});

export type McpServerSettings = z.infer<typeof mcpServerSettings>;

/**
 * The persisted settings, as a schema. The `Settings` type and the defaults
 * are both derived from it, and hydration parses through it, so adding a
 * field is one edit here rather than five — and a stored value is validated
 * instead of cast. Each `field` carries its own fallback, which replaces
 * the hand-written `?? DEFAULTS.x` re-enumeration hydration used to carry.
 */
const settingsSchema = z.object({
  /** Left-hand gutter beside each chat block. */
  lineNumber: field(z.enum(["off", "absolute", "relative"]), "absolute"),
  /** Whether preformatted content, code and a tool's output, wraps instead
   *  of scrolling sideways. */
  wordWrap: field(z.enum(["off", "on"]), "off"),
  /** Root font size in px. Applied to `<html>`, so every rem-sized element
   *  scales with it. */
  fontSize: field(z.number().int(), DEFAULT_FONT_SIZE),
  /** Default URL of an OpenAI-completions provider, e.g.
   *  "http://seer:4000/v1". An agent block appends "/chat/completions"
   *  itself. */
  aiEndpoint: field(z.string(), ""),
  /** Bearer token sent to `aiEndpoint`. */
  aiApiKey: field(z.string(), ""),
  /** Default model an inference run (an agent block, or the `X` modal's
   *  row) falls back to when its own `model` field is blank. */
  inferDefaultModel: field(z.string(), ""),
  /** Per-provider settings (routing preferences, and the like), keyed by
   *  the provider id `shared/provider-routing.ts` detects from
   *  `aiEndpoint`. Keyed rather than flat so flipping endpoints between
   *  two known providers never clobbers the other one's saved values. */
  aiProviderSettings: field(
    z.record(z.string(), z.record(z.string(), z.string())),
    {},
  ),
  /** Per-provider settings for summarization runs, keyed by the provider
   *  id detected from the shared `aiEndpoint`. Same shape and purpose as
   *  `aiProviderSettings`, kept apart so summaries can be tuned (or left
   *  untuned) independently of the model that answers blocks. */
  summProviderSettings: field(
    z.record(z.string(), z.record(z.string(), z.string())),
    {},
  ),
  /** Reasoning effort the inference run asks the model for, one of
   *  pi's own levels (see `shared/agent-events.ts`), or blank for the SDK's
   *  default. App-wide default of the `X` modal's row. */
  inferThinkingLevel: field(z.string(), ""),
  /** Cap on how many output tokens a default inference run's model may
   *  produce. Zero means no cap (the provider's own default). The `X`
   *  modal's per-run override draws from this when it leaves the field
   *  blank. */
  inferMaxTokens: field(z.number(), 8192),
  /** Same for a default summarization run; blank falls back to
   *  `inferThinkingLevel`, like the default model beside it. */
  summThinkingLevel: field(z.string(), ""),
  /** Same cap for a default summarization run, kept apart from
   *  `inferMaxTokens` so a summary can be capped independently of the
   *  model that answers blocks; zero means no cap (the provider's own
   *  default). Each defaults to the same hardcoded cap a fresh install has
   *  always had. */
  summMaxTokens: field(z.number(), 8192),
  /** What pi's `DefaultResourceLoader` loads on each inference run,
   *  inverted (`true` = don't load) so the names match the SDK flags the
   *  main process passes through. These are the app-wide defaults the `X`
   *  modal prefills per run. Same five flags, samely named, for a
   *  summarization run (`summNo…`): summaries share the inference harness
   *  defaults or tune them half as hard, whichever the rows below set. */
  inferNoExtensions: field(z.boolean(), false),
  inferNoSkills: field(z.boolean(), false),
  inferNoPromptTemplates: field(z.boolean(), true),
  inferNoThemes: field(z.boolean(), true),
  inferNoContextFiles: field(z.boolean(), false),
  /** Same five `DefaultResourceLoader` flags for a summarization run. */
  summNoExtensions: field(z.boolean(), false),
  summNoSkills: field(z.boolean(), false),
  summNoPromptTemplates: field(z.boolean(), true),
  summNoThemes: field(z.boolean(), true),
  summNoContextFiles: field(z.boolean(), false),
  /** The MCP servers the app may mount, keyed by the name a server's tools
   *  are namespaced under. Every run reads this list: an enabled server is
   *  mounted on each agent run (inference, or a summary that rides the
   *  agent), and each connection lives only as long as its run. Keyed rather
   *  than listed so that a server keeps its name and its settings while a
   *  person edits one field, and so the settings page can give each one its
   *  own section. */
  mcpServers: field(z.record(z.string(), mcpServerSettings), {}),
  /** Whether a summarization run (`s` / `S`) goes through the pi agent
   *  instead of a plain LLM call. Off keeps the read-only compress-and-
   *  reply behavior; on mounts the whole harness, so the `summNo…` rows
   *  next to it (extensions, skills, prompt templates, themes, context
   *  files) actually apply and the run can use tools. */
  summAgent: field(z.boolean(), false),
  /** Default model a summarization run (`s` on a block) falls back to when
   *  its own `model` field is blank. Kept apart from the inference default
   *  so a smaller or cheaper model can compress conversations without
   *  touching the one that answers them; a blank value falls back to
   *  `inferDefaultModel`. Summarization runs share the endpoint and key
   *  with inference (`aiEndpoint`/`aiApiKey`). */
  summDefaultModel: field(z.string(), ""),
});

export type Settings = z.infer<typeof settingsSchema>;

const STORAGE_KEY = "weaver.settings";

/** A fresh, complete `Settings`, read through the schema like every other
 *  persisted value so a bad default fails here rather than at first use. */
const DEFAULTS: Settings = settingsSchema.parse({});

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
  /** Names a new MCP server. It appears as an empty `stdio` one, which no
   *  run mounts until it has a command. */
  addMcpServer: (name: string) => void;
  /** Merges one field into one server's settings, leaving the rest alone. */
  setMcpServer: (name: string, patch: Partial<McpServerSettings>) => void;
  removeMcpServer: (name: string) => void;
  setAiApiKey: (value: string) => void;
  setInferDefaultModel: (value: string) => void;
  setInferNoExtensions: (value: boolean) => void;
  setInferNoSkills: (value: boolean) => void;
  setInferNoPromptTemplates: (value: boolean) => void;
  setInferNoThemes: (value: boolean) => void;
  setInferNoContextFiles: (value: boolean) => void;
  setSummDefaultModel: (value: string) => void;
  setSummAgent: (value: boolean) => void;
  setSummNoExtensions: (value: boolean) => void;
  setSummNoSkills: (value: boolean) => void;
  setSummNoPromptTemplates: (value: boolean) => void;
  setSummNoThemes: (value: boolean) => void;
  setSummNoContextFiles: (value: boolean) => void;
  setInferThinkingLevel: (value: string) => void;
  setSummThinkingLevel: (value: string) => void;
  setInferMaxTokens: (value: number) => void;
  setSummMaxTokens: (value: number) => void;
  setProviderField: (providerId: string, key: string, value: string) => void;
  setSummProviderField: (
    providerId: string,
    key: string,
    value: string,
  ) => void;
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
        // Parsed through the schema, so every field is present and of the
        // right type: a stored blob missing a key (an older version) or
        // holding a wrong-typed one falls back to its default per field,
        // and a value that is not settings at all fails the parse and is
        // treated like an empty store below.
        const stored = raw ? settingsSchema.parse(JSON.parse(raw)) : DEFAULTS;
        commit({ settings: stored, hydrated: true });
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
  const set = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      const next = { ...current.settings, [key]: value };
      commit({ settings: next, hydrated: current.hydrated });
      void window.api.settings.set(STORAGE_KEY, JSON.stringify(next));
    },
    [],
  );

  const setLineNumber = useCallback(
    (lineNumber: LineNumberMode) => set("lineNumber", lineNumber),
    [set],
  );
  const setFontSize = useCallback(
    (size: number) => set("fontSize", size),
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
  /** Adds one MCP server under `name`, complete and empty, so the settings
   *  page can render its rows the moment it is typed. A name already in use
   *  is left as it is: renaming is deleting and adding, not overwriting a
   *  server that may already be configured. */
  const addMcpServer = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      if (current.settings.mcpServers[trimmed]) return;
      set("mcpServers", {
        ...current.settings.mcpServers,
        [trimmed]: mcpServerSettings.parse({}),
      });
    },
    [set],
  );
  const setMcpServer = useCallback(
    (name: string, patch: Partial<McpServerSettings>) => {
      set("mcpServers", {
        ...current.settings.mcpServers,
        [name]: {
          ...mcpServerSettings.parse({}),
          ...current.settings.mcpServers[name],
          ...patch,
        },
      });
    },
    [set],
  );
  const removeMcpServer = useCallback(
    (name: string) => {
      const next = { ...current.settings.mcpServers };
      delete next[name];
      set("mcpServers", next);
    },
    [set],
  );
  const setAiApiKey = useCallback(
    (value: string) => set("aiApiKey", value),
    [set],
  );
  const setInferDefaultModel = useCallback(
    (value: string) => set("inferDefaultModel", value),
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
  /** Merges one field into one provider's settings bag, same as
   *  `setProviderField` for the summarization side. */
  const setSummProviderField = useCallback(
    (providerId: string, key: string, value: string) => {
      set("summProviderSettings", {
        ...current.settings.summProviderSettings,
        [providerId]: {
          ...current.settings.summProviderSettings[providerId],
          [key]: value,
        },
      });
    },
    [set],
  );
  const setInferNoExtensions = useCallback(
    (value: boolean) => set("inferNoExtensions", value),
    [set],
  );
  const setInferNoSkills = useCallback(
    (value: boolean) => set("inferNoSkills", value),
    [set],
  );
  const setInferNoPromptTemplates = useCallback(
    (value: boolean) => set("inferNoPromptTemplates", value),
    [set],
  );
  const setInferNoThemes = useCallback(
    (value: boolean) => set("inferNoThemes", value),
    [set],
  );
  const setInferNoContextFiles = useCallback(
    (value: boolean) => set("inferNoContextFiles", value),
    [set],
  );
  const setSummNoExtensions = useCallback(
    (value: boolean) => set("summNoExtensions", value),
    [set],
  );
  const setSummNoSkills = useCallback(
    (value: boolean) => set("summNoSkills", value),
    [set],
  );
  const setSummNoPromptTemplates = useCallback(
    (value: boolean) => set("summNoPromptTemplates", value),
    [set],
  );
  const setSummNoThemes = useCallback(
    (value: boolean) => set("summNoThemes", value),
    [set],
  );
  const setSummNoContextFiles = useCallback(
    (value: boolean) => set("summNoContextFiles", value),
    [set],
  );
  const setSummDefaultModel = useCallback(
    (value: string) => set("summDefaultModel", value),
    [set],
  );
  const setSummAgent = useCallback(
    (value: boolean) => set("summAgent", value),
    [set],
  );
  const setInferThinkingLevel = useCallback(
    (value: string) => set("inferThinkingLevel", value),
    [set],
  );
  const setSummThinkingLevel = useCallback(
    (value: string) => set("summThinkingLevel", value),
    [set],
  );
  const setInferMaxTokens = useCallback(
    (value: number) => set("inferMaxTokens", value),
    [set],
  );
  const setSummMaxTokens = useCallback(
    (value: number) => set("summMaxTokens", value),
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
      addMcpServer,
      setMcpServer,
      removeMcpServer,
      setAiApiKey,
      setInferDefaultModel,
      setProviderField,
      setSummProviderField,
      setInferNoExtensions,
      setInferNoSkills,
      setInferNoPromptTemplates,
      setInferNoThemes,
      setInferNoContextFiles,
      setSummNoExtensions,
      setSummNoSkills,
      setSummNoPromptTemplates,
      setSummNoThemes,
      setSummNoContextFiles,
      setSummDefaultModel,
      setSummAgent,
      setInferThinkingLevel,
      setSummThinkingLevel,
      setInferMaxTokens,
      setSummMaxTokens,
    }),
    [
      settings,
      hydrated,
      setLineNumber,
      setWordWrap,
      setFontSize,
      setAiEndpoint,
      addMcpServer,
      setMcpServer,
      removeMcpServer,
      setAiApiKey,
      setInferDefaultModel,
      setProviderField,
      setSummProviderField,
      setInferNoExtensions,
      setInferNoSkills,
      setInferNoPromptTemplates,
      setInferNoThemes,
      setInferNoContextFiles,
      setSummNoExtensions,
      setSummNoSkills,
      setSummNoPromptTemplates,
      setSummNoThemes,
      setSummNoContextFiles,
      setSummDefaultModel,
      setSummAgent,
      setInferThinkingLevel,
      setSummThinkingLevel,
      setInferMaxTokens,
      setSummMaxTokens,
    ],
  );

  return <context.Provider value={value}>{children}</context.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(context);
  if (!value)
    throw new Error("useSettings must be used within SettingsProvider");
  return value;
}
