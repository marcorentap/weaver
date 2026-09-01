"use client";

import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  LINE_NUMBER_OPTIONS,
  useSettings,
  type LineNumberMode,
} from "@/lib/settings";
import { useKeyLayer } from "@/lib/keymap";
import { cn } from "@/lib/utils";

/**
 * A setting's shape decides how it is displayed and edited:
 * - `option` cycles through a fixed list with `h`/`l` or the chevrons.
 * - `number` also cycles by `step` with `h`/`l`, and — like `string` — can be
 *   typed directly: `enter` swaps the value for a text box, `enter` again
 *   commits it, `esc` discards the draft and returns to navigation.
 */
type SettingDef =
  | {
      kind: "option";
      key: string;
      label: string;
      description: string;
      options: readonly { value: string; label: string }[];
      value: string;
      onChange: (value: string) => void;
    }
  | {
      kind: "number";
      key: string;
      label: string;
      description: string;
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
      value: string;
      onChange: (value: string) => void;
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
      return def.value || "—";
  }
}

/** `h`/`l` and the chevrons: only `option` and `number` settings respond. */
function cycle(def: SettingDef, direction: 1 | -1) {
  if (def.kind === "option") {
    const values = def.options.map((option) => option.value);
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

/** `number` and `string` settings can also be typed directly. */
function isEditable(def: SettingDef): def is Extract<
  SettingDef,
  { kind: "number" | "string" }
> {
  return def.kind === "number" || def.kind === "string";
}

function commitEdit(def: Extract<SettingDef, { kind: "number" | "string" }>, raw: string) {
  if (def.kind === "number") {
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return;
    const clamped = Math.min(
      def.max ?? Infinity,
      Math.max(def.min ?? -Infinity, parsed),
    );
    def.onChange(clamped);
  } else {
    def.onChange(raw);
  }
}

export default function SettingsPage() {
  const { settings, hydrated, setLineNumber } = useSettings();
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const defs: SettingDef[] = [
    {
      kind: "option",
      key: "lineNumber",
      label: "Line number",
      description: "Show each block's position in the left gutter of chat.",
      options: LINE_NUMBER_OPTIONS,
      value: settings.lineNumber,
      onChange: (value) => setLineNumber(value as LineNumberMode),
    },
  ];

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
    // The input mounts this render; focus it once it exists.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const finishEdit = () => {
    if (editing && def && def.key === editing && isEditable(def)) {
      commitEdit(def, draft);
    }
    setEditing(null);
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
          return (
            <div
              key={entry.key}
              aria-selected={selected}
              onClick={() => setCursor(i)}
              className={cn(
                "flex cursor-pointer items-center gap-3 border-l-2 py-1 pl-1 pr-3",
                selected
                  ? "border-foreground/60 bg-muted"
                  : "border-transparent hover:bg-muted/40",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{entry.label}</span>
                <span className="block text-muted-foreground">
                  {entry.description}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
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
                {isEditing ? (
                  <input
                    ref={inputRef}
                    value={draft}
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
                        setEditing(null);
                      }
                    }}
                    className="w-20 border-b border-foreground/40 bg-transparent text-center outline-none"
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
                      "w-20 text-center tabular-nums",
                      isEditable(entry) ? "cursor-text hover:text-foreground" : "",
                    )}
                  >
                    {hydrated ? displayValue(entry) : ""}
                  </span>
                )}
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
