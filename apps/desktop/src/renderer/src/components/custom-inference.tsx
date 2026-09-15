import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  detectProvider,
  type ProviderField,
} from "@shared/provider-routing.js";
import { THINKING_LEVEL_OPTIONS } from "@/lib/settings";
import { ModalFrame } from "@/components/modal-frame";
import { useKeyLayer } from "@/lib/keymap";
import { cn } from "@/lib/utils";

/** The per-run settings the `X` / `S` dialogs collect on a block before
 *  running. The endpoint, key and provider fields prefill from the saved
 *  settings; `agentic` only a summary run carries, so a summary can ride
 *  the agent or stay a plain call. Every field falls back to its saved
 *  default when blank. */
export type CustomInferenceRun = {
  endpoint: string;
  apiKey: string;
  /** Model this run uses; blank falls back to the saved default. */
  model: string;
  /** Reasoning effort for this run; blank falls back to the saved
   *  inference/summarization default, exactly like the other fields. */
  thinkingLevel?: string;
  providerId?: string;
  providerSettings?: Record<string, string>;
  /** Whether a summarization ride the pi agent instead of going out
   *  as a plain LLM call. Set only by the `S` dialog; an inference run is
   *  always an agent run, so its custom payload never carries this. */
  agentic?: boolean;
  /** What pi's `DefaultResourceLoader` loads for this run; `true` = don't
   *  load. Omitted by callers that don't aim the run (plain `x`), which
   *  then fall back to the saved inference settings. */
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
};

/** On/off choice the discovery rows use, mirroring the settings page. */
const ON_OFF_OPTIONS = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

/**
 * A settings-style row inside the dialog: a label column on the left and a
 * value on the right, mirroring `SettingsPage`'s layout. `option` rows cycle
 * with `h`/`l` and the chevrons; `string` rows are typed by pressing enter;
 * `action` (the Run row) runs on enter.
 */
type RowDef =
  | {
      key: string;
      kind: "string";
      label: string;
      description: string;
      value: string;
      secret?: boolean;
      placeholder?: string;
      onChange: (value: string) => void;
    }
  | {
      key: string;
      kind: "option";
      label: string;
      description: string;
      options: readonly { value: string; label: string }[];
      value: string;
      onChange: (value: string) => void;
    }
  | {
      key: "run";
      kind: "action";
      label: string;
      description: string;
      actionLabel: string;
    };

/** One labeled row + value column, the settings page's own row shape. */
const INDENT_REM = 1;

/**
 * The `X` / `S` modal. `enter` → `x` / `s` runs the block with the saved
 * settings; `enter` → `X` / `S` opens this and lets the per-run fields be
 * changed. It mirrors the settings page's "Inference settings" and
 * "Summarization settings" sections: the same rows, same order — model,
 * thinking level, and (agent runs only) what pi's loader pulls in — with
 * nothing extra. The endpoint, key and provider tuning the page keeps in
 * its "AI provider" section stay fixed to the saved settings, since those
 * are not per-run settings. The `S` summarization run reuses it with a
 * different title and `runLabel`, and gets an Agentic row the inference
 * dialog doesn't have: summaries are plain LLM calls unless the toggle
 * rides the agent, and the agent's harness rows only appear when it does.
 * For the inference run the dialog is always agentic, so no toggle row and
 * the discovery rows always show.
 * The layout is the settings page's own: rows with a label column and a
 * value column, `j`/`k` to move, `h`/`l` or the chevrons to cycle an
 * option, `enter` to type a string value or run, `esc` to cancel the edit
 * and then the dialog. Every value prefills from the saved settings so a
 * single tweak (change the model, enter, enter) is a one-step run.
 * Nothing persists: this is a run, not a settings edit.
 */
export function CustomInferenceDialog({
  id,
  title,
  meta,
  runLabel = "Run inference",
  defaults,
  onRun,
  onCancel,
  agentic,
}: {
  id: string;
  title: string;
  meta?: string;
  /** The run row renders as this: "Run inference" for `X`, "Run
   *  summarization" when the `S` custom summary reuses the dialog. */
  runLabel?: string;
  /** The saved settings to prefill from. Agent-run rows (the discovery
   *  flags) may be absent for a plain run, which has no loader. */
  defaults: {
    model: string;
    thinkingLevel?: string;
    noExtensions?: boolean;
    noSkills?: boolean;
    noPromptTemplates?: boolean;
    noThemes?: boolean;
    noContextFiles?: boolean;
  };
  onRun: (run: CustomInferenceRun) => void;
  onCancel: () => void;
  /** The `S` summarization dialog's initial agentic state. Undefined means
   *  the run cannot go plain (the `X` inference dialog, always an agent
   *  run): the Agentic row is hidden and the discovery rows always show.
   *  The summarization dialog passes the saved `summAgent` setting. */
  agentic?: boolean;
}) {
  const [model, setModel] = useState(defaults.model);
  const [thinkingLevel, setThinkingLevel] = useState(
    defaults.thinkingLevel ?? "",
  );
  /** Whether this run rides the agent harness. Inference is always agentic
   *  (`agentic` prop undefined); the summary dialog starts from the saved
   *  setting and the row flips it. */
  const [isAgentic, setIsAgentic] = useState(agentic ?? true);
  /** The dialog can switch a run out of plain mode: true for inference
   *  (which has no toggle) and for the summary dialog when agentic is on.
   *  Only when true do the discovery rows appear and the flags ship. */
  const showAgentic = agentic === undefined || isAgentic;
  const [noExtensions, setNoExtensions] = useState(
    defaults.noExtensions ?? false,
  );
  const [noSkills, setNoSkills] = useState(defaults.noSkills ?? false);
  const [noPromptTemplates, setNoPromptTemplates] = useState(
    defaults.noPromptTemplates ?? false,
  );
  const [noThemes, setNoThemes] = useState(defaults.noThemes ?? false);
  const [noContextFiles, setNoContextFiles] = useState(
    defaults.noContextFiles ?? false,
  );
  /** The harness-discovery rows (pi extensions, skills, prompt templates,
   *  themes, context files) of the settings page's "Inference settings"
   *  section, shown only for agent runs; a plain run has no loader, so
   *  these would tune nothing and stay empty. */
  const discoveryRows: RowDef[] = !showAgentic
    ? []
    : [
        {
          key: "noExtensions",
          kind: "option",
          label: "Pi extensions",
          description: "Load pi extensions (slash commands, hooks, tools).",
          options: ON_OFF_OPTIONS,
          value: noExtensions ? "off" : "on",
          onChange: (value) => setNoExtensions(value === "off"),
        },
        {
          key: "noSkills",
          kind: "option",
          label: "Skills",
          description:
            "Load SKILL.md files from the agent and project directories.",
          options: ON_OFF_OPTIONS,
          value: noSkills ? "off" : "on",
          onChange: (value) => setNoSkills(value === "off"),
        },
        {
          key: "noPromptTemplates",
          kind: "option",
          label: "Prompt templates",
          description:
            "Load pi prompt templates (/agent, /session, system personas).",
          options: ON_OFF_OPTIONS,
          value: noPromptTemplates ? "off" : "on",
          onChange: (value) => setNoPromptTemplates(value === "off"),
        },
        {
          key: "noThemes",
          kind: "option",
          label: "Themes",
          description: "Load pi themes.",
          options: ON_OFF_OPTIONS,
          value: noThemes ? "off" : "on",
          onChange: (value) => setNoThemes(value === "off"),
        },
        {
          key: "noContextFiles",
          kind: "option",
          label: "Context files",
          description: "Load project context files (CONTEXT.md / AGENTS.md).",
          options: ON_OFF_OPTIONS,
          value: noContextFiles ? "off" : "on",
          onChange: (value) => setNoContextFiles(value === "off"),
        },
      ];

  /** Rows the way settings would render them: the run action first, then
   *  each settings-page field for the run's kind — nothing the page's own
   *  sections don't carry. */
  const rows: RowDef[] = [
    {
      key: "run",
      kind: "action",
      label: runLabel,
      description: "Run with the settings above.",
      actionLabel: "Run",
    },
    {
      key: "model",
      kind: "string",
      label: "Default model",
      description: "Default when a block's own model field is blank.",
      value: model,
      placeholder: "gpt-4o",
      onChange: setModel,
    },
    {
      key: "thinkingLevel",
      kind: "option",
      label: "Thinking level",
      description: "Reasoning effort. Support varies by model.",
      options: THINKING_LEVEL_OPTIONS,
      value: thinkingLevel,
      onChange: setThinkingLevel,
    },
    // A summary can be a plain call or an agent run; this toggle decides
    // which, and gates the harness rows below. Inference is always an
    // agent run, so only the summary dialog gets the row. It mirrors the
    // settings page's "Summarization settings" agentic toggle (the
    // `summAgent` setting it prefills from).
    ...(agentic === undefined
      ? []
      : [
          {
            key: "agentic",
            kind: "option",
            label: "Agentic",
            description:
              "Run through the pi agent (tools, skills, extensions) or as a plain LLM call.",
            options: ON_OFF_OPTIONS,
            value: isAgentic ? "on" : "off",
            onChange: (value) => setIsAgentic(value === "on"),
          },
        ]),
    // What pi's DefaultResourceLoader loads for this run, same rows the
    // settings page's "Inference settings" section shows; skipped for a
    // plain run, which has no loader. On/off here reads as the feature it
    // enables (`no…` is the saved/inverted value).
    ...discoveryRows,
  ];

  const submit = () =>
    onRun({
      model: model.trim(),
      thinkingLevel: thinkingLevel || undefined,
      // The `S` dialog reports its agentic choice; inference always runs
      // the agent, so no flag travels for it.
      ...(agentic === undefined ? {} : { agentic: isAgentic }),
      // A plain summary has no loader, so its discovery flags are neither
      // shown nor sent. (An inference dialog is always agentic, so its
      // `showAgentic` is always true.)
      ...(showAgentic
        ? {
            noExtensions,
            noSkills,
            noPromptTemplates,
            noThemes,
            noContextFiles,
          }
        : {}),
    });

  const [cursor, setCursor] = useState(0);
  const index = Math.min(cursor, Math.max(rows.length - 1, 0));
  const row = rows[index];
  /** The row currently being typed into, by key; null when navigating. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const move = (delta: number) => {
    if (rows.length === 0) return;
    setCursor(Math.min(Math.max(index + delta, 0), rows.length - 1));
  };

  const startEdit = (target: RowDef) => {
    if (target.kind !== "string") return;
    setDraft(target.value);
    setEditing(target.key);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  /** Cycles an option's value, or no-ops on a string/action row — the same
   *  `h`/`l` behavior the settings page has. */
  const cycle = (direction: 1 | -1) => {
    if (row?.kind !== "option") return;
    const values = row.options.map((option) => option.value);
    if (values.length === 0) return;
    const at = values.indexOf(row.value);
    const next = values[(at + direction + values.length) % values.length]!;
    row.onChange(next);
  };

  useKeyLayer({
    id,
    modal: true,
    bindings: [
      {
        keys: ["ArrowDown", "j"],
        help: [{ keys: "↓ / j", label: "Next row" }],
        run: () => move(1),
      },
      {
        keys: ["ArrowUp", "k"],
        help: [{ keys: "↑ / k", label: "Previous row" }],
        run: () => move(-1),
      },
      {
        keys: ["ArrowLeft", "h"],
        help: [{
          keys: "← / h",
          label: row?.kind === "option" ? "Previous value" : "Previous row",
        }],
        run: () =>
          row?.kind === "option" && editing === null ? cycle(-1) : move(-1),
      },
      {
        keys: ["ArrowRight", "l"],
        help: [{
          keys: "→ / l",
          label: row?.kind === "option" ? "Next value" : "Next row",
        }],
        run: () =>
          row?.kind === "option" && editing === null ? cycle(1) : move(1),
      },
      {
        keys: ["Enter"],
        help: [{
          keys: "enter",
          label: row?.kind === "action" ? "Run" : "Type a value",
        }],
        run: () => {
          if (!row) return;
          if (row.kind === "action") submit();
          else startEdit(row);
        },
      },
      {
        keys: ["Escape"],
        help: [{ keys: "esc", label: "Close" }],
        run: onCancel,
      },
    ],
  });

  return (
    <ModalFrame
      label={title}
      title={title}
      meta={meta}
      size="xl"
      footer="esc closes — j/k move, h/l cycle, enter types or runs"
      onClose={onCancel}
    >
      <ul className="max-h-[70vh] overflow-y-auto overscroll-contain py-1">
        {rows.map((rowDef, i) => {
          const selected = i === index;
          const isEditing = editing === rowDef.key;
          return (
            <li key={rowDef.key}>
              <div
                aria-selected={selected}
                onClick={() => setCursor(i)}
                className={cn(
                  "flex cursor-pointer items-start gap-3 py-1 pl-1 pr-3",
                  selected && "bg-muted",
                )}
              >
                {/* The label column, same width step as settings. */}
                <span
                  className="flex w-52 shrink-0 items-center gap-1"
                  style={{ paddingLeft: `${INDENT_REM}rem` }}
                >
                  <span className="min-w-0 truncate font-medium">
                    {rowDef.label}
                  </span>
                </span>
                {rowDef.kind === "action" ? (
                  <span className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="min-w-0 flex-1 text-muted-foreground">
                      {rowDef.description}
                    </span>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setCursor(i);
                        submit();
                      }}
                      className="shrink-0 cursor-pointer rounded border border-foreground/30 px-2 py-0.5 text-xs"
                    >
                      {rowDef.actionLabel}
                    </button>
                  </span>
                ) : (
                  <span className="flex min-w-0 flex-1 flex-col items-start">
                    <span className="flex w-full items-start gap-3">
                      <span className="min-w-0 flex-1 text-muted-foreground">
                        {rowDef.description}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <span className="flex size-4 shrink-0 items-center justify-center">
                          {rowDef.kind === "string" ? null : (
                            <button
                              type="button"
                              aria-label="Previous value"
                              onClick={(event) => {
                                event.stopPropagation();
                                setCursor(i);
                                rowDef.onChange(
                                  rowDef.options[
                                    (rowDef.options.findIndex(
                                      (option) => option.value === rowDef.value,
                                    ) -
                                      1 +
                                      rowDef.options.length) %
                                      rowDef.options.length
                                  ]!.value,
                                );
                              }}
                              className="text-muted-foreground hover:text-foreground"
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
                              rowDef.kind === "string" && rowDef.secret
                                ? "password"
                                : "text"
                            }
                            placeholder={
                              rowDef.kind === "string"
                                ? rowDef.placeholder
                                : undefined
                            }
                            spellCheck={false}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                rowDef.onChange(draft);
                                setEditing(null);
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                setEditing(null);
                              }
                            }}
                            className={cn(
                              "w-56 border-b border-foreground/40 bg-transparent outline-none placeholder:text-muted-foreground/50",
                              rowDef.kind === "string"
                                ? "text-left"
                                : "text-center",
                            )}
                          />
                        ) : (
                          <span
                            onClick={(event) => {
                              if (rowDef.kind !== "string") return;
                              event.stopPropagation();
                              setCursor(i);
                              startEdit(rowDef);
                            }}
                            className={cn(
                              "w-56 truncate tabular-nums text-left",
                              rowDef.kind === "string" &&
                                "cursor-text hover:text-foreground",
                            )}
                          >
                            {/* Values: options show their label, so the blank
                             *  default (`value: ""`) reads as "Default"
                             *  instead of an empty column. Secrets mask with
                             *  dots plus the last four characters, like a
                             *  stored key shown for confirmation — short
                             *  secrets (4 chars or fewer) fall back to full
                             *  masking. Strings show value or placeholder. */}
                            {rowDef.kind === "option" ? (
                              (rowDef.options.find(
                                (option) => option.value === rowDef.value,
                              )?.label ?? rowDef.value)
                            ) : rowDef.kind === "string" && rowDef.secret ? (
                              rowDef.value ? (
                                rowDef.value.length > 4 ? (
                                  `••••${rowDef.value.slice(-4)}`
                                ) : (
                                  "•".repeat(8)
                                )
                              ) : rowDef.placeholder ? (
                                <span className="text-muted-foreground/50">
                                  {rowDef.placeholder}
                                </span>
                              ) : (
                                ""
                              )
                            ) : rowDef.value ? (
                              rowDef.value
                            ) : rowDef.placeholder ? (
                              <span className="text-muted-foreground/50">
                                {rowDef.placeholder}
                              </span>
                            ) : (
                              ""
                            )}
                          </span>
                        )}
                        <span className="flex size-4 shrink-0 items-center justify-center">
                          {rowDef.kind === "string" ? null : (
                            <button
                              type="button"
                              aria-label="Next value"
                              onClick={(event) => {
                                event.stopPropagation();
                                setCursor(i);
                                rowDef.onChange(
                                  rowDef.options[
                                    (rowDef.options.findIndex(
                                      (option) => option.value === rowDef.value,
                                    ) +
                                      1) %
                                      rowDef.options.length
                                  ]!.value,
                                );
                              }}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <ChevronRight className="size-4" />
                            </button>
                          )}
                        </span>
                      </span>
                    </span>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </ModalFrame>
  );
}
