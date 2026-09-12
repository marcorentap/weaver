import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  LINE_NUMBER_OPTIONS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  useSettings,
  WORD_WRAP_OPTIONS,
  type LineNumberMode,
  type WordWrapMode,
} from "@/lib/settings";
import { useKeyLayer } from "@/lib/keymap";
import { useViewportBindings } from "@/lib/viewport";
import { providerUrl } from "@/lib/provider";
import { cn } from "@/lib/utils";
import type {
  PluginListResult,
  PluginSettingFieldWire,
  ProviderUsageResult,
} from "@shared/ipc-contract.js";
import type { RemoteInstanceStatus, RemoteKeySummary } from "@shared/remote.js";
import { detectProvider } from "@shared/provider-routing.js";
import { MarkdownText } from "@/components/markdown";
import { ShellHeader } from "@/components/app-shell";
import { Gutter } from "@/components/gutter";

/** Rows nested under a group fold one notch right of the group header,
 *  the same indent step chat's blocks use. */
const INDENT_REM = 1;

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
      /** Shown under the row, in red, whenever non-null. Unlike `validate`,
       *  checked every render rather than only on commit, so a value that
       *  was fine when set but is stale now (the default model changed
       *  under it) still gets flagged. */
      warning?: string | null;
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
    }
  | {
      /** Not a value to change, just markdown content: an OpenRouter
       *  usage table, a note, whatever a provider or plugin wants to show
       *  under its section. Rendered full-width, in place of the usual
       *  label/value columns; `j`/`k` still land on it, nothing else does. */
      kind: "info";
      key: string;
      section?: string;
      content: string;
    }
  | {
      /** An action rather than a value: create a key, start the server, or
       *  whatever else a settings row needs. Enter clicks it. */
      kind: "action";
      key: string;
      label: string;
      description: string;
      section?: string;
      /** Label of the button on the row, e.g. "Create". */
      actionLabel: string;
      onRun: () => void;
      disabled?: boolean;
    }
  | {
      /** The keys a machine's own instance has issued, with a revoke
       *  button on each. Not a value to set; the row just is the list. */
      kind: "keys";
      key: string;
      section?: string;
      intro: string;
      keys: RemoteKeySummary[];
      onRevoke: (id: string) => Promise<void> | void;
      /** While a revoke is in flight, that key's button yields. */
      revokingId?: string | null;
    };

/** One visible row of the settings list, mirroring a chat page row: a
 *  line-number gutter, a label column, and the entry's own content. A
 *  section header renders as a group row (the same shape chat gives a
 *  group block), and the settings under it fold one notch deeper. */
type Row =
  | { kind: "group"; title: string }
  | { kind: "entry"; def: SettingDef };

/** Flatten the flat `defs` list into groups. Each definition carrying a
 *  `section` starts a new group row; the definitions after it (until the
 *  next one that names a section, or the end) become that group's rows.
 *  `closed` holds the titles of groups folded like chat's collapsed
 *  groups: their rows are left out of the list entirely (they get no
 *  gutter number and no cursor), and reopening them reflows the numbers. */
function flattenRows(defs: SettingDef[], closed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  let current: string | null = null;
  for (const def of defs) {
    if (def.section !== undefined) {
      current = def.section;
      rows.push({ kind: "group", title: def.section });
      if (!closed.has(def.section)) rows.push({ kind: "entry", def });
    } else if (current !== null) {
      if (!closed.has(current)) rows.push({ kind: "entry", def });
    } else {
      // A definition before any section marker still renders, at top level.
      rows.push({ kind: "entry", def });
    }
  }
  return rows;
}

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
    case "info":
    case "action":
    case "keys":
      return "";
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

/** On/off choice used by the remote toggles. */
const ON_OFF_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const;

/** Lifetimes offered when creating a key, and their seconds. */
const KEY_LIFETIME_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "1h", label: "1 hour" },
  { value: "12h", label: "12 hours" },
  { value: "24h", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
] as const;

const KEY_LIFETIME_SECONDS: Readonly<Record<string, number | null>> = {
  never: null,
  "1h": 3600,
  "12h": 43200,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
  "90d": 7776000,
};

const YES_NO_OPTIONS = [
  { value: "no", label: "No" },
  { value: "yes", label: "Yes" },
] as const;

/** Whether a host string is a usable http(s) base URL. */
function hostOk(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  try {
    const url = new URL(trimmed);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

/** OpenRouter's key usage, as a markdown table for the "info" row under
 *  provider settings. Credits are USD, 1:1. */
function usageMarkdown(usage: NonNullable<ProviderUsageResult["usage"]>): string {
  const usd = (value: number) => `$${value.toFixed(2)}`;
  return [
    `${usage.label}${usage.isFreeTier ? " (free tier)" : ""}`,
    "",
    "| | |",
    "|---|---|",
    `| Today | ${usd(usage.usageDaily)} |`,
    `| This week | ${usd(usage.usageWeekly)} |`,
    `| This month | ${usd(usage.usageMonthly)} |`,
    `| All time | ${usd(usage.usage)} |`,
    `| Key limit | ${usage.limit === null ? "Unlimited" : usd(usage.limit)} |`,
    `| Remaining | ${usage.limitRemaining === null ? "Unlimited" : usd(usage.limitRemaining)} |`,
  ].join("\n");
}

export default function SettingsPage() {
  const {
    settings,
    hydrated,
    setLineNumber,
    setWordWrap,
    setFontSize,
    setAiEndpoint,
    setAiApiKey,
    setAiDefaultModel,
    setProviderField,
    setRemoteEnabled,
    setRemoteHost,
    setRemotePort,
    setRemoteKey,
    setRemoteServerEnabled,
    setRemoteServerHost,
    setRemoteServerPort,
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
    modelParameters?: Record<string, string[]>;
  } | null>(null);
  /** OpenRouter's own per-key usage; unrelated to `probe`, `null` when not
   *  applicable or not fetched yet. */
  const [usage, setUsage] = useState<ProviderUsageResult | null>(null);
  /** Result of the last remote connection probe; `ok: null` in flight. */
  const [remoteProbe, setRemoteProbe] = useState<{
    ok: boolean | null;
    message: string;
    admin: boolean;
  } | null>(null);
  /** Status of this machine's own server and a message from its last
   *  start/stop (a bind error, say). */
  const [instanceStatus, setInstanceStatus] = useState<
    RemoteInstanceStatus | null
  >(null);
  const [instanceMessage, setInstanceMessage] = useState<string | null>(null);
  /** Keys this machine has issued. */
  const [remoteKeys, setRemoteKeys] = useState<RemoteKeySummary[]>([]);
  /** New-key form state; only the newest token is shown, once. */
  const [keyName, setKeyName] = useState("");
  const [keyLifetime, setKeyLifetime] = useState("24h");
  const [keyAdmin, setKeyAdmin] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Anchors the shared page-scroll keys (`ctrl+d` / `ctrl+u` / `G` / `gg`)
   *  to the scrolling box this page lives in, the shell's `<main>`. */
  const rootRef = useRef<HTMLDivElement>(null);
  const viewport = useViewportBindings(rootRef);
  /** Sections the user has folded shut; their rows leave the list, like a
   *  collapsed group in chat (they keep no gutter number and no cursor). */
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());

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

  const provider = detectProvider(settings.aiEndpoint);

  /** Re-read this machine's server status and its keys. */
  const refreshRemoteState = useCallback(async () => {
    const [status, keys] = await Promise.all([
      window.api.remote.instance.status(),
      window.api.remote.keys.list(),
    ]);
    setInstanceStatus(status);
    setRemoteKeys(keys);
  }, []);

  /** Turn the machine's own server on or off. */
  const toggleServer = async (next: boolean) => {
    setRemoteServerEnabled(next);
    if (next) {
      const result = await window.api.remote.instance.start(
        settings.remoteServerPort,
        settings.remoteServerHost,
      );
      setInstanceMessage(result.ok ? null : result.message);
    } else {
      await window.api.remote.instance.stop();
      setInstanceMessage(null);
    }
    setInstanceStatus(await window.api.remote.instance.status());
  };

  /** Create a key with the form's name/lifetime/admin, then show its token
   *  exactly once. */
  const createKey = async () => {
    if (keyBusy) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      const result = await window.api.remote.keys.create({
        name: keyName.trim() || undefined,
        lifetimeSeconds: KEY_LIFETIME_SECONDS[keyLifetime] ?? null,
        admin: keyAdmin,
      });
      setCreatedKey(result.key);
      setKeyName("");
      setRemoteKeys(await window.api.remote.keys.list());
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error));
    } finally {
      setKeyBusy(false);
    }
  };

  const revokeKey = async (id: string) => {
    setRevokingId(id);
    setKeyError(null);
    try {
      await window.api.remote.keys.revoke(id);
      setRemoteKeys(await window.api.remote.keys.list());
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error));
    } finally {
      setRevokingId(null);
    }
  };

  /** Asks the remote instance whether the current credentials work, for the
   *  connection row; runs on every committed host/port/key change. */
  const checkRemoteConnection = useCallback(
    async (host: string, port: number, key: string) => {
      if (!host.trim() && !key.trim()) {
        setRemoteProbe(null);
        return;
      }
      setRemoteProbe({ ok: null, message: "checking…", admin: false });
      try {
        const verdict = await window.api.remote.check(host, port, key);
        setRemoteProbe({
          ok: verdict.ok,
          message: verdict.message,
          admin: verdict.admin,
        });
      } catch (error) {
        setRemoteProbe({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          admin: false,
        });
      }
    },
    [],
  );

  const remoteConnectionText = remoteProbe
    ? remoteProbe.ok === null
      ? "Checking…"
      : `${remoteProbe.ok ? "Connected" : "Failed"}: ${remoteProbe.message}${remoteProbe.admin ? " (admin)" : ""}`
    : "Not checked.";

  const serverStatusText = instanceStatus?.running
    ? `Running at ${instanceStatus.url}${instanceMessage ? ` — ${instanceMessage}` : ""}.`
    : instanceMessage
      ? `Stopped (${instanceMessage}).`
      : "Stopped.";

  const createdKeyText = createdKey
    ? `**Copy it now — shown once**: \`${createdKey}\``
    : "";

  const keyErrorText = keyError
    ? `⚠ ${keyError}`
    : "";

  const defs: SettingDef[] = [
    {
      kind: "option",
      key: "lineNumber",
      label: "Line number",
      description: "Show each row's position in the gutter.",
      section: "Appearance",
      options: LINE_NUMBER_OPTIONS,
      value: settings.lineNumber,
      onChange: (value) => setLineNumber(value as LineNumberMode),
    },
    {
      kind: "option",
      key: "wordWrap",
      label: "Word wrap",
      description: "Wrap long lines instead of scrolling.",
      options: WORD_WRAP_OPTIONS,
      value: settings.wordWrap,
      onChange: (value) => setWordWrap(value as WordWrapMode),
    },
    {
      kind: "number",
      key: "fontSize",
      label: "Font size",
      description: "Root text size in px.",
      value: settings.fontSize,
      step: 1,
      min: MIN_FONT_SIZE,
      max: MAX_FONT_SIZE,
      onChange: setFontSize,
    },
    {
      kind: "string",
      key: "aiEndpoint",
      label: "Endpoint",
      description: "OpenAI-completions base URL.",
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
      description: "Bearer token for the endpoint.",
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
      description: "Default when a block's own model is blank.",
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
    // A provider detected from the endpoint above gets its own fields,
    // read from and written back to its own slot in `aiProviderSettings`
    // so switching endpoints never clobbers another provider's saved
    // values. Nothing renders here for an endpoint that matches none.
    ...(provider ?? { fields: [] }).fields.map(
      (field, i): SettingDef =>
        field.options
          ? {
              kind: "option",
              key: `provider.${provider!.id}.${field.key}`,
              label: field.label,
              description: field.description,
              section: i === 0 ? "Provider settings" : undefined,
              options: field.options,
              value: settings.aiProviderSettings[provider!.id]?.[field.key] ?? "",
              onChange: (value) =>
                setProviderField(provider!.id, field.key, value),
              warning:
                field.key === "thinkingLevel" &&
                settings.aiProviderSettings[provider!.id]?.thinkingLevel &&
                settings.aiDefaultModel &&
                probe?.modelParameters?.[settings.aiDefaultModel] &&
                !probe.modelParameters[settings.aiDefaultModel]!.includes(
                  "reasoning",
                )
                  ? `${settings.aiDefaultModel} doesn't list reasoning support`
                  : null,
            }
          : {
              kind: "string",
              key: `provider.${provider!.id}.${field.key}`,
              label: field.label,
              description: field.description,
              section: i === 0 ? "Provider settings" : undefined,
              value: settings.aiProviderSettings[provider!.id]?.[field.key] ?? "",
              onChange: (value) =>
                setProviderField(provider!.id, field.key, value),
              placeholder: field.placeholder,
            },
    ),
    ...(provider?.id === "openrouter"
      ? [
          {
            kind: "info" as const,
            key: `provider.${provider.id}.usage`,
            content:
              usage?.ok && usage.usage
                ? usageMarkdown(usage.usage)
                : `Usage: ${usage?.message ?? "checking…"}`,
          },
        ]
      : []),

    // Remote: where this app sends its agent runs when the toggle is on.
    {
      kind: "option",
      key: "remoteEnabled",
      label: "Use remote instance",
      description: "Run agent blocks on another weaver instance.",
      section: "Remote",
      options: ON_OFF_OPTIONS,
      value: settings.remoteEnabled ? "on" : "off",
      onChange: (value) => setRemoteEnabled(value === "on"),
    },
    {
      kind: "string",
      key: "remoteHost",
      label: "URL",
      description: "Base URL of the instance.",
      value: settings.remoteHost,
      onChange: setRemoteHost,
      placeholder: "http://192.168.1.20",
      validate: (value) =>
        hostOk(value) ? null : "needs a scheme and host, e.g. http://192.168.1.20",
    },
    {
      kind: "number",
      key: "remotePort",
      label: "Port",
      description: "Connection port.",
      value: settings.remotePort,
      step: 1,
      min: 1,
      max: 65535,
      onChange: setRemotePort,
    },
    {
      kind: "string",
      key: "remoteKey",
      label: "Key",
      description: "Key issued by the instance.",
      value: settings.remoteKey,
      onChange: setRemoteKey,
      secret: true,
      placeholder: "wrk_...",
    },
    {
      kind: "info",
      key: "remoteConnection",
      section: undefined,
      content: !settings.remoteHost.trim() && !settings.remoteKey.trim()
        ? "Not configured."
        : remoteConnectionText,
    },

    // This machine's own server: the toggle is also the start/stop.
    {
      kind: "option",
      key: "remoteServerEnabled",
      label: "Serve this machine",
      description: "Accept connections from other weaver apps.",
      section: "Remote server",
      options: ON_OFF_OPTIONS,
      value: settings.remoteServerEnabled ? "on" : "off",
      // Not a plain setter: the switch is a live start/stop, and only
      // reports back once the instance has actually come up.
      onChange: (value) => void toggleServer(value === "on"),
    },
    {
      kind: "string",
      key: "remoteServerHost",
      label: "Listen host",
      description: "Interface to listen on.",
      value: settings.remoteServerHost,
      onChange: setRemoteServerHost,
      placeholder: "0.0.0.0",
    },
    {
      kind: "number",
      key: "remoteServerPort",
      label: "Listen port",
      description: "Port others connect to.",
      value: settings.remoteServerPort,
      step: 1,
      min: 1,
      max: 65535,
      onChange: setRemoteServerPort,
    },
    {
      kind: "info",
      key: "remoteServerStatus",
      content: serverStatusText,
    },

    // Keys this machine has issued.
    {
      kind: "string",
      key: "remoteNewKeyName",
      label: "Name",
      description: "Key name.",
      section: "Remote keys",
      value: keyName,
      onChange: setKeyName,
      placeholder: "laptop",
    },
    {
      kind: "option",
      key: "remoteNewKeyLifetime",
      label: "Lifetime",
      description: "How long the key is valid.",
      options: KEY_LIFETIME_OPTIONS,
      value: keyLifetime,
      onChange: setKeyLifetime,
    },
    {
      kind: "option",
      key: "remoteNewKeyAdmin",
      label: "Admin",
      description: "Mark the key as admin.",
      options: YES_NO_OPTIONS,
      value: keyAdmin ? "yes" : "no",
      onChange: (value) => setKeyAdmin(value === "yes"),
    },
    {
      kind: "action",
      key: "remoteCreateKey",
      label: "Create key",
      description: "Issue a new key.",
      actionLabel: keyBusy ? "…" : "Create",
      disabled: keyBusy,
      onRun: () => void createKey(),
    },
    {
      kind: "info",
      key: "remoteKeyResult",
      content: keyErrorText || createdKeyText,
    },
    {
      kind: "keys",
      key: "remoteKeysList",
      intro: "Key tokens show once, at creation. Create a new key if you lost one.",
      keys: remoteKeys,
      revokingId,
      onRevoke: revokeKey,
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
      description: "Directory holding plugin subdirectories.",
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

  /** Fold or unfold a section (its title is the group's key). */
  const toggleGroup = (title: string) => {
    setClosed((previous) => {
      const next = new Set(previous);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  };

  const rows = flattenRows(defs, closed);
  const index = Math.min(cursor, Math.max(rows.length - 1, 0));
  const row = rows[index];
  /** The setting under the cursor; undefined while a group header is. */
  const def = row?.kind === "entry" ? row.def : undefined;
  /** Whether the gutter column is live at all (hidden before hydration so
   *  the stored preference never flashes in with the wrong mode). */
  const gutter = hydrated && settings.lineNumber !== "off";
  /** Number for a row. Absolute is its 1-based position; relative is its
   *  distance from the cursor, except the selected row, which reads its own
   *  1-based position instead of the useless anchor `0`. Group headers
   *  count as rows, exactly like chat's group blocks. */
  const lineNumber = (i: number): number | null =>
    gutter
      ? settings.lineNumber === "relative" && i !== index
        ? Math.abs(i - index)
        : i + 1
      : null;
  /** The row currently under the cursor, so the page follows it. Every
   *  branch renders a `<div>`, so one shared `HTMLDivElement` ref works. */
  const selectedRef = useRef<HTMLElement | null>(null);
  const setSelectedRef = useCallback((element: HTMLElement | null) => {
    selectedRef.current = element;
  }, []);

  // Keep the selected row in view as the cursor moves. `block: "nearest"`
  // scrolls only when the row is actually off screen, so navigating near the
  // top or bottom never lurches the page. Also fires on remounts (the
  // page re-renders when `defs` grows, e.g. plugins load, or a group folds,
  // changing the row count) so a jump to a row still lands on screen.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [index, rows.length, closed]);

  const move = (delta: number) => {
    if (rows.length === 0) return;
    setCursor(Math.min(Math.max(index + delta, 0), rows.length - 1));
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
      setProbe({
        ok: verdict.ok,
        message: verdict.message,
        models: verdict.models,
        modelParameters: verdict.modelParameters,
      });
    } catch (error) {
      setProbe({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  /** OpenRouter-only key usage. Same shape of probe as `checkProvider`. */
  const fetchUsage = useCallback(async (endpoint: string, apiKey: string) => {
    if (!apiKey) {
      setUsage(null);
      return;
    }
    try {
      setUsage(await window.api.agent.providerUsage(endpoint, apiKey));
    } catch (error) {
      setUsage({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
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

  // Same as above, for OpenRouter usage. Runs on visit and whenever the
  // endpoint or key changes, so a fresh key never shows stale numbers.
  useEffect(() => {
    if (!hydrated || provider?.id !== "openrouter") return;
    if (!settings.aiApiKey) return;
    const timer = setTimeout(
      () => void fetchUsage(settings.aiEndpoint, settings.aiApiKey),
      0,
    );
    return () => clearTimeout(timer);
  }, [hydrated, provider?.id, settings.aiEndpoint, settings.aiApiKey, fetchUsage]);

  // Remote: read this machine's server status and keys once on visit.
  useEffect(() => {
    const timer = setTimeout(() => void refreshRemoteState(), 0);
    return () => clearTimeout(timer);
  }, [refreshRemoteState]);

  // Probe the remote connection whenever its host/port/key changes, the
  // same deferred-out-of-the-effect shape as the provider probe above.
  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(() => {
      if (!settings.remoteHost.trim() && !settings.remoteKey.trim()) {
        setRemoteProbe(null);
        return;
      }
      void checkRemoteConnection(
        settings.remoteHost,
        settings.remotePort,
        settings.remoteKey,
      );
    }, 0);
    return () => clearTimeout(timer);
  }, [
    hydrated,
    settings.remoteHost,
    settings.remotePort,
    settings.remoteKey,
    checkRemoteConnection,
  ]);

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
      // The page-scroll keys every page shares: half a viewport with
      // `ctrl+d`/`ctrl+u`, `G` to the bottom, `gg` to the top.
      ...viewport,
      {
        keys: ["ArrowDown", "j"],
        help: { keys: "↓ / j / <n>j", label: "Next setting, <n> at a time" },
        run: (count = 1) => move(count),
      },
      {
        keys: ["ArrowUp", "k"],
        help: { keys: "↑ / k / <n>k", label: "Previous setting, <n> at a time" },
        run: (count = 1) => move(-count),
      },
      {
        keys: ["ArrowLeft", "h"],
        help: {
          keys: "← / h",
          label: row?.kind === "group" ? "Close section" : "Previous value",
        },
        run: () => {
          if (row?.kind === "group") {
            // Only closing shuts a section; `h` on an already folded group
            // is a no-op, the way chat's step-out is.
            if (!closed.has(row.title)) toggleGroup(row.title);
            return;
          }
          if (def) cycle(def, -1);
        },
      },
      {
        keys: ["ArrowRight", "l"],
        help: {
          keys: "→ / l",
          label: row?.kind === "group" ? "Open section" : "Next value",
        },
        run: () => {
          if (row?.kind === "group") {
            // Unfold, or step into the first row once it is already open,
            // chat's `l`-on-a-group "open then step in".
            if (closed.has(row.title)) toggleGroup(row.title);
            else move(1);
            return;
          }
          if (def) cycle(def, 1);
        },
      },
      {
        keys: ["Enter"],
        help: {
          keys: "enter",
          label:
            row?.kind === "group"
              ? "Fold / unfold section"
              : def?.kind === "action"
                ? "Run"
                : "Type a value",
        },
        run: () =>
          row?.kind === "group"
            ? toggleGroup(row.title)
            : def && (def.kind === "action" ? def.onRun() : startEdit(def)),
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
    <div ref={rootRef} className="flex min-h-full flex-col">
      {/* Rendered through the shell's header slot (like ChatPage) so the
       *  "Settings" line stays visible above the scroll area instead of
       *  scrolling out of view with the rows. */}
      <ShellHeader>
        <header className="border-b px-3 py-1">
          <span className="font-semibold">Settings</span>
        </header>
      </ShellHeader>

      <div className="py-1">
        {rows.map((row, i) => {
          const selected = i === index;
          if (row.kind === "group") {
            const folded = closed.has(row.title);
            return (
              <div
                key={`group:${row.title}`}
                ref={selected ? setSelectedRef : undefined}
                aria-selected={selected}
                aria-expanded={!folded}
                onClick={() => setCursor(i)}
                className={cn(
                  "flex cursor-pointer items-start gap-3 py-1 pl-1 pr-3",
                  selected && "bg-muted",
                )}
              >
                <Gutter line={lineNumber(i)} show={gutter} current={selected} />
                <span className="flex w-52 shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label={folded ? "Expand section" : "Collapse section"}
                    // The row itself is the selection target, so the chevron
                    // has to keep its click to itself, padded past the glyph.
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleGroup(row.title);
                    }}
                    className="-my-1 shrink-0 p-1 text-muted-foreground hover:text-foreground"
                  >
                    {folded ? (
                      <ChevronRight className="size-4" />
                    ) : (
                      <ChevronDown className="size-4" />
                    )}
                  </button>
                  <span className="min-w-0 truncate font-medium text-muted-foreground">
                    {row.title}
                  </span>
                </span>
                {/* The content column stays empty; a section header carries
                 *  no value of its own. */}
                <span className="flex min-w-0 flex-1 items-start" />
              </div>
            );
          }

          const entry = row.def;
          const isEditing = editing === entry.key;
          const showPlaceholder =
            entry.kind === "string" &&
            !entry.value &&
            !isEditing &&
            entry.placeholder;
          return (
            <div
              key={entry.key}
              ref={selected ? setSelectedRef : undefined}
              aria-selected={selected}
              onClick={() => setCursor(i)}
              className={cn(
                "flex cursor-pointer items-start gap-3 py-1 pl-1 pr-3",
                selected && "bg-muted",
              )}
            >
              <Gutter line={lineNumber(i)} show={gutter} current={selected} />
              {/* The label column, indented one notch because every setting
               *  lives inside a section group, the chat page's group step. */}
              <span
                className="flex w-52 shrink-0 items-center gap-1"
                style={{ paddingLeft: `${INDENT_REM}rem` }}
              >
                {entry.kind === "info" || entry.kind === "keys" ? null : (
                  <span className="min-w-0 truncate font-medium">
                    {entry.label}
                  </span>
                )}
              </span>
              {entry.kind === "action" ? (
                <span className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    {entry.description}
                  </span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setCursor(i);
                      entry.onRun();
                    }}
                    className={cn(
                      "shrink-0 cursor-pointer rounded border px-2 py-0.5 text-xs",
                      entry.disabled
                        ? "border-border/60 text-muted-foreground/50"
                        : "border-foreground/30",
                    )}
                  >
                    {entry.actionLabel}
                  </button>
                </span>
              ) : entry.kind === "keys" ? (
                <span className="flex min-w-0 flex-1 flex-col items-start">
                  <span className="text-muted-foreground">{entry.intro}</span>
                  {entry.keys.length === 0 ? (
                    <span className="mt-1 text-muted-foreground">
                      No keys yet — create one above.
                    </span>
                  ) : (
                    <span className="mt-1 w-full">
                      {entry.keys.map((key) => {
                        const expired =
                          key.expiresAt !== null && key.expiresAt <= Date.now();
                        const active = !key.revokedAt && !expired;
                        const expires = key.expiresAt
                          ? new Date(key.expiresAt).toLocaleDateString()
                          : null;
                        return (
                          <span
                            key={key.id}
                            className="flex w-full items-center gap-2 border-b border-border/60 py-1 last:border-b-0"
                          >
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate font-mono text-xs",
                                !active && "text-muted-foreground line-through",
                              )}
                            >
                              {key.name}
                            </span>
                            {key.admin ? (
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                admin
                              </span>
                            ) : null}
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {key.revokedAt
                                ? "revoked"
                                : expired
                                  ? "expired"
                                  : expires
                                    ? `until ${expires}`
                                    : "no expiry"}
                            </span>
                            {active ? (
                              <button
                                type="button"
                                disabled={entry.revokingId === key.id}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void entry.onRevoke(key.id);
                                }}
                                className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-destructive disabled:cursor-wait disabled:opacity-40"
                              >
                                Revoke
                              </button>
                            ) : null}
                          </span>
                        );
                      })}
                    </span>
                  )}
                </span>
              ) : entry.kind === "info" ? (
                <span className="flex min-w-0 flex-1 flex-col items-start">
                  <MarkdownText text={entry.content} />
                </span>
              ) : (
                <span className="flex min-w-0 flex-1 flex-col items-start">
                  <span className="flex w-full items-start gap-3">
                    <span className="min-w-0 flex-1 text-muted-foreground">
                      {entry.description}
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
                            entry.kind === "string"
                              ? entry.placeholder
                              : undefined
                          }
                          inputMode={
                            entry.kind === "number" ? "decimal" : "text"
                          }
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
                            entry.kind === "string"
                              ? "text-left"
                              : "text-center",
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
                            "w-56 truncate tabular-nums text-right",
                            entry.kind === "option" && "text-left",
                            entry.kind === "string" && "text-left",
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
                  </span>
                  {isEditing && fieldError ? (
                    <span className="mt-0.5 text-destructive">
                      {entry.label}: {fieldError}
                    </span>
                  ) : null}
                  {!isEditing && entry.kind === "option" && entry.warning ? (
                    <span className="mt-0.5 text-destructive">
                      {entry.label}: {entry.warning}
                    </span>
                  ) : null}
                  {entry.kind === "string" && entry.key === "aiApiKey" && probe ? (
                    <span
                      className={cn(
                        "text-xs",
                        probe.ok === false
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      Provider: {probe.message}
                    </span>
                  ) : null}
                  {entry.kind === "string" &&
                  entry.key === "aiDefaultModel" &&
                  probe?.models?.length ? (
                    <span className="w-full py-1">
                      <span className="block font-medium">
                        Available models
                      </span>
                      <span className="mt-1 block max-h-40 overflow-auto rounded border border-border font-mono text-xs text-muted-foreground">
                        {probe.models.map((model) => (
                          <span
                            key={model}
                            className="block border-b border-border/60 px-2 py-1 last:border-b-0"
                          >
                            {model}
                          </span>
                        ))}
                      </span>
                    </span>
                  ) : null}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
