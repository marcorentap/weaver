import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  LINE_NUMBER_OPTIONS,
  useSettings,
  WORD_WRAP_OPTIONS,
  type LineNumberMode,
  type WordWrapMode,
} from "@/lib/settings";
import { useKeyLayer } from "@/lib/keymap";
import { providerUrl } from "@/lib/provider";
import { cn } from "@/lib/utils";
import type {
  PluginListResult,
  PluginSettingFieldWire,
} from "@shared/ipc-contract.js";

/**
 * A setting's shape decides how it is displayed and edited:
 * - `option` cycles through a fixed list with `h`/`l` or the chevrons.
 * - `number` also cycles by `step` with `h`/`l`, and like `string` can be
 *   typed directly. `enter` swaps the value for a text box, `enter` again
 *   commits it, `esc` discards the draft and returns to navigation.
 */
type SettingDef =
  | {
      kind: "option";
      key: string;
      label: string;
      description: string;
      /** A section heading rendered above this entry. Only the first
       *  entry of a group sets it. */
      section?: string;
      options: readonly { value: string; label: string }[];
      value: string;
      onChange: (value: string) => void;
      /** Also editable by typing (enter), like a string setting. */
      editable?: boolean;
      /** Rejects a typed value on `enter`, returning why. */
      validate?: (value: string) => string | null;
    }
  | {
      kind: "number";
      key: string;
      label: string;
      description: string;
      section?: string;
      value: number;
      step: number;
      min?: number;
      max?: number;
      onChange: (value: number) => void;
    }
  | {
      kind: "string";
      key: string;
      label: string;
      description: string;
      section?: string;
      value: string;
      onChange: (value: string) => void;
      /** Rejects a typed value on `enter`, returning why. A rejected edit
       *  stays open with the draft intact, so nothing is silently dropped
       *  and nothing invalid is ever stored. */
      validate?: (value: string) => string | null;
      /** Part of the provider credentials. Committing it re-runs the live
       *  reachability check. */
      provider?: boolean;
      /** Masked when not focused for editing, an API key. */
      secret?: boolean;
      /** Shown, in gray, in place of an empty value, an example rather
       *  than a default. */
      placeholder?: string;
    };

function displayValue(def: SettingDef): string {
  switch (def.kind) {
    case "option":
      return (
        def.options.find((option) => option.value === def.value)?.label ??
        def.value
      );
    case "number":
      return String(def.value);
    case "string":
      return def.value ? (def.secret ? "•".repeat(8) : def.value) : "";
  }
}

/** Only `option` and `number` settings respond to `h`/`l` or the chevrons. */
function cycle(def: SettingDef, direction: 1 | -1) {
  if (def.kind === "option") {
    const values = def.options.map((option) => option.value);
    if (values.length === 0) return;
    const index = values.indexOf(def.value);
    const next = values[(index + direction + values.length) % values.length]!;
    def.onChange(next);
  } else if (def.kind === "number") {
    const next = def.value + direction * def.step;
    const clamped = Math.min(
      def.max ?? Infinity,
      Math.max(def.min ?? -Infinity, next),
    );
    def.onChange(clamped);
  }
}

/** Settings you can type a value into: `number` and `string`, plus an
 *  `option` marked editable (pick from the list or type your own). */
type EditableSettingDef =
  | Extract<SettingDef, { kind: "number" | "string" }>
  | (Extract<SettingDef, { kind: "option" }> & { editable: true });

function isEditable(def: SettingDef): def is EditableSettingDef {
  return (
    def.kind === "number" ||
    def.kind === "string" ||
    (def.kind === "option" && def.editable === true)
  );
}

function commitEdit(def: EditableSettingDef, raw: string) {
  if (def.kind === "number") {
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return;
    const clamped = Math.min(
      def.max ?? Infinity,
      Math.max(def.min ?? -Infinity, parsed),
    );
    def.onChange(clamped);
  } else {
    // `string` and a typeable `option` both commit plain text.
    def.onChange(raw);
  }
}

export default function SettingsPage() {
  const {
    settings,
    hydrated,
    setLineNumber,
    setWordWrap,
    setAiEndpoint,
    setAiApiKey,
    setAiDefaultModel,
  } = useSettings();
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Why the open edit was rejected, if it was. */
  const [fieldError, setFieldError] = useState<string | null>(null);
  /** Result of the last provider check; `ok: null` while it is in flight. */
  const [probe, setProbe] = useState<{
    ok: boolean | null;
    message: string;
    models?: string[];
  } | null>(null);
const inputRef = useRef<HTMLInputElement>(null);

  /** Loaded plugins and their setting values, fetched over IPC so the
   *  Settings page reflects the plugins actually loaded, not a hardcoded
   *  set. */
  const [pluginList, setPluginList] = useState<PluginListResult | null>(null);
  const [pluginValues, setPluginValues] = useState<
    Record<string, Record<string, string>>
  >({});

  useEffect(() => {
    void (async () => {
      const result = await window.api.plugins.list();
      setPluginList(result);
      const values: Record<string, Record<string, string>> = {};
      for (const plugin of result.plugins) {
        const raw = await window.api.settings.get(`weaver.plugins.${plugin.id}`);
        try {
          const parsed = raw ? (JSON.parse(raw) as unknown) : null;
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
          ) {
            values[plugin.id] = Object.fromEntries(
              Object.entries(parsed).map(([key, value]) => [
                key,
                typeof value === "string" || typeof value === "number"
                  ? String(value)
                  : "",
              ]),
            );
          }
        } catch {
          // Corrupt plugin settings are ignored, same as app settings.
        }
        values[plugin.id] ??= {};
      }
      setPluginValues(values);
    })();
  }, []);

  /** Persist one plugin setting field and update the local copy. */
  const setPluginField = (
    pluginId: string,
    key: string,
    value: string,
  ) => {
    const next = { ...pluginValues[pluginId], [key]: value };
    setPluginValues({ ...pluginValues, [pluginId]: next });
    void window.api.settings.set(
      `weaver.plugins.${pluginId}`,
      JSON.stringify(next),
    );
  };

  /** A plugin setting field becomes one editable row, under the plugin's
   *  own section. */
  function pluginSettingDef(
    plugin: PluginListResult["plugins"][number],
    field: PluginSettingFieldWire,
    pluginId: string,
  ): SettingDef {
    const value = pluginValues[pluginId]?.[field.key] ?? "";
    const section = plugin.name;
    if (field.kind === "number") {
      return {
        kind: "number",
        key: field.key,
        label: field.label,
        description: field.description,
        section,
        value: value === "" ? 0 : Number(value),
        step: field.step ?? 1,
        min: field.min,
        max: field.max,
        onChange: (next) =>
          setPluginField(pluginId, field.key, String(next)),
      };
    }
    if (field.kind === "option") {
      return {
        kind: "option",
        key: field.key,
        label: field.label,
        description: field.description,
        section,
        options: field.options ?? [],
        value,
        editable: field.editable,
        onChange: (next) => setPluginField(pluginId, field.key, next),
      };
    }
    return {
      kind: "string",
      key: field.key,
      label: field.label,
      description: field.description,
      section,
      value,
      onChange: (next) => setPluginField(pluginId, field.key, next),
      placeholder: field.placeholder,
      secret: field.secret,
    };
  }

  const defs: SettingDef[] = [
    {
      kind: "option",
      key: "lineNumber",
      label: "Line number",
      description: "Show each block's position in the left gutter of chat.",
      section: "Appearance",
      options: LINE_NUMBER_OPTIONS,
      value: settings.lineNumber,
      onChange: (value) => setLineNumber(value as LineNumberMode),
    },
    {
      kind: "option",
      key: "wordWrap",
      label: "Word wrap",
      description:
        "Wrap long lines in code and tool output instead of scrolling sideways.",
      options: WORD_WRAP_OPTIONS,
      value: settings.wordWrap,
      onChange: (value) => setWordWrap(value as WordWrapMode),
    },
    {
      kind: "string",
      key: "aiEndpoint",
      label: "Endpoint",
      description: "OpenAI-completions base URL used for inference.",
      section: "AI provider",
      value: settings.aiEndpoint,
      onChange: setAiEndpoint,
      placeholder: "https://api.openai.com/v1",
      provider: true,
      // Same check the proxy route runs, so a URL accepted here is one
      // inference can actually call.
      validate: (value) =>
        !value.trim() || providerUrl(value, "models")
          ? null
          : "needs a scheme and host, e.g. https://api.openai.com/v1",
    },
    {
      kind: "string",
      key: "aiApiKey",
      label: "API key",
      description: "Bearer token sent to the endpoint above.",
      value: settings.aiApiKey,
      onChange: setAiApiKey,
      secret: true,
      placeholder: "sk-...",
      provider: true,
    },
    {
      kind: "option",
      key: "aiDefaultModel",
      label: "Default model",
      description: "Used when an agent block's own model field is blank.",
      // The arrows cycle the provider's reported models. Enter types a
      // value by hand; it must be one of the available models once the
      // list has loaded, or a blank (provider default).
      options: (probe?.models ?? []).map((model) => ({
        value: model,
        label: model,
      })),
      value: settings.aiDefaultModel,
      onChange: setAiDefaultModel,
      editable: true,
      validate: (value) => {
        if (value && probe?.models?.length && !probe.models.includes(value)) {
          return "invalid model";
        }
        return null;
      },
    },
    ];

  // Plugin contributions come last: a "Plugins" section for the directory
  // setting, then one section per loaded plugin for its own settings. Each
  // plugin's fields and their values are what the main process reported at
  // startup, so sections track the plugins actually loaded.
  if (pluginList) {
    defs.push({
      kind: "string",
      key: "plugins.dir",
      label: "Plugins directory",
      description:
        "Directory holding plugin subdirectories (blocks/, tools/). Plugins here load at startup, no rebuild.",
      section: "Plugins",
      value: pluginList.dir,
      onChange: (value) => {
        void window.api.settings.set("weaver.plugins.dir", value);
        setPluginList({ ...pluginList, dir: value });
      },
    });
    for (const plugin of pluginList.plugins) {
      for (const field of plugin.settings ?? []) {
        defs.push(pluginSettingDef(plugin, field, plugin.id));
      }
    }
  }

  const index = Math.min(cursor, Math.max(defs.length - 1, 0));
  const def = defs[index];

  const move = (delta: number) => {
    if (defs.length === 0) return;
    setCursor(Math.min(Math.max(index + delta, 0), defs.length - 1));
  };

  const startEdit = (target: SettingDef) => {
    if (!isEditable(target)) return;
    setDraft(String(target.value));
    setEditing(target.key);
    setFieldError(null);
    // The input mounts this render; focus it once it exists.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  /** Asks the main process whether the current pair actually works. Runs on
   *  every committed endpoint or key, and once when the page loads, since
   *  either input alone proves nothing. */
  const checkProvider = useCallback(async (endpoint: string, apiKey: string) => {
    if (!endpoint.trim() && !apiKey) {
      setProbe(null);
      return;
    }
    setProbe({ ok: null, message: "checking…" });
    try {
      const verdict = await window.api.agent.check(endpoint, apiKey);
      setProbe({ ok: verdict.ok, message: verdict.message, models: verdict.models });
    } catch {
      setProbe({ ok: false, message: "check request failed" });
    }
  }, []);

  // Probe once on visit, so the models list is there without forcing a
  // re-edit. Deferred out of the effect so the synchronous setProbe never
  // runs inside one (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!hydrated) return;
    if (!settings.aiEndpoint.trim() || !settings.aiApiKey) return;
    const timer = setTimeout(
      () => void checkProvider(settings.aiEndpoint, settings.aiApiKey),
      0,
    );
    return () => clearTimeout(timer);
  }, [hydrated, settings.aiEndpoint, settings.aiApiKey, checkProvider]);

  const finishEdit = () => {
    if (!editing || !def || def.key !== editing || !isEditable(def)) {
      setEditing(null);
      return;
    }
    const invalid =
      isEditable(def) && def.kind !== "number"
        ? (def.validate?.(draft) ?? null)
        : null;
    if (invalid) {
      // Stays open with the draft intact. The value is the user's, and
      // discarding what they typed to tell them it was wrong is hostile.
      setFieldError(invalid);
      return;
    }
    commitEdit(def, draft);
    setFieldError(null);
    setEditing(null);
    if (def.kind === "string" && def.provider) {
      void checkProvider(
        def.key === "aiEndpoint" ? draft : settings.aiEndpoint,
        def.key === "aiApiKey" ? draft : settings.aiApiKey,
      );
    }
  };

  useKeyLayer({
    id: "settings",
    bindings: [
      {
        keys: ["ArrowDown", "j"],
        help: { keys: "↓ / j", label: "Next setting" },
        run: () => move(1),
      },
      {
        keys: ["ArrowUp", "k"],
        help: { keys: "↑ / k", label: "Previous setting" },
        run: () => move(-1),
      },
      {
        keys: ["ArrowLeft", "h"],
        help: { keys: "← / h", label: "Previous value" },
        run: () => def && cycle(def, -1),
      },
      {
        keys: ["ArrowRight", "l"],
        help: { keys: "→ / l", label: "Next value" },
        run: () => def && cycle(def, 1),
      },
      {
        keys: ["Enter"],
        help: { keys: "enter", label: "Type a value" },
        run: () => def && startEdit(def),
      },
    ],
  });

  // While the inline text box is focused, the keymap ignores every keydown
  // (see `isTextEntry`), so enter/escape are handled here instead.
  useKeyLayer({
    id: "settings-edit",
    modal: Boolean(editing),
    bindings: [],
    docs: editing
      ? [
          { keys: "enter", label: "Save value" },
          { keys: "esc", label: "Cancel" },
        ]
      : [],
  });

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b px-3 py-1">
        <span className="font-semibold">Settings</span>
      </header>

      <div className="py-1">
        {defs.map((entry, i) => {
          const selected = i === index;
          const isEditing = editing === entry.key;
          const showPlaceholder =
            entry.kind === "string" &&
            !entry.value &&
            !isEditing &&
            entry.placeholder;
          return (
            <Fragment key={entry.key}>
              {entry.section ? (
                <div className="px-1 pt-3 pb-1 text-muted-foreground/70">
                  {entry.section}
                </div>
              ) : null}
              <div
                aria-selected={selected}
                onClick={() => setCursor(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-3 border-l-2 py-1 pl-1 pr-3",
                  selected
                    ? "border-foreground/60 bg-muted"
                    : "border-transparent",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{entry.label}</span>
                  <span className="block text-muted-foreground">
                    {entry.description}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {entry.kind === "string" ? null : (
                      <button
                        type="button"
                        aria-label="Previous value"
                        disabled={!hydrated}
                        onClick={(event) => {
                          event.stopPropagation();
                          setCursor(i);
                          cycle(entry, -1);
                        }}
                        className="text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                      >
                        <ChevronLeft className="size-4" />
                      </button>
                    )}
                  </span>
                  {isEditing ? (
                    <input
                      ref={inputRef}
                      value={draft}
                      type={
                        entry.kind === "string" && entry.secret
                          ? "password"
                          : "text"
                      }
                      placeholder={
                        entry.kind === "string" ? entry.placeholder : undefined
                      }
                      inputMode={entry.kind === "number" ? "decimal" : "text"}
                      spellCheck={false}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={finishEdit}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          finishEdit();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setFieldError(null);
                          setEditing(null);
                        }
                      }}
                      className={cn(
                        "w-56 border-b border-foreground/40 bg-transparent outline-none placeholder:text-muted-foreground/50",
                        entry.kind === "string" ? "text-left" : "text-center",
                      )}
                    />
                  ) : (
                    <span
                      onClick={(event) => {
                        if (!isEditable(entry)) return;
                        event.stopPropagation();
                        setCursor(i);
                        startEdit(entry);
                      }}
                      className={cn(
                        "w-56 truncate tabular-nums",
                        entry.kind === "string" ? "text-left" : "text-center",
                        isEditable(entry)
                          ? "cursor-text hover:text-foreground"
                          : "",
                      )}
                    >
                      {hydrated
                        ? showPlaceholder
                          ? (
                              <span className="text-muted-foreground/50">
                                {entry.placeholder}
                              </span>
                            )
                          : displayValue(entry)
                        : ""}
                    </span>
                  )}
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {entry.kind === "string" ? null : (
                      <button
                        type="button"
                        aria-label="Next value"
                        disabled={!hydrated}
                        onClick={(event) => {
                          event.stopPropagation();
                          setCursor(i);
                          cycle(entry, 1);
                        }}
                        className="text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                      >
                        <ChevronRight className="size-4" />
                      </button>
                    )}
                  </span>
                </span>
              </div>
              {isEditing && fieldError ? (
                <div className="px-1 pb-1 pl-1 text-destructive">
                  {entry.label}: {fieldError}
                </div>
              ) : null}
              {entry.kind === "string" && entry.key === "aiApiKey" && probe ? (
                <div
                  className={cn(
                    "px-1 pb-1 pl-1",
                    probe.ok === false
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  Provider: {probe.message}
                </div>
              ) : null}
              {entry.kind === "string" &&
              entry.key === "aiDefaultModel" &&
              probe?.models?.length ? (
                <div className="border-l-2 border-transparent py-1 pl-1 pr-3">
                  <span className="block font-medium">Available models</span>
                  <div className="mt-1 max-h-40 overflow-auto rounded border border-border font-mono text-xs text-muted-foreground">
                    {probe.models.map((model) => (
                      <div
                        key={model}
                        className="border-b border-border/60 px-2 py-1 last:border-b-0"
                      >
                        {model}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
