import { useEffect, useRef, useState } from "react";
import { Square, SquareCheck } from "lucide-react";
import type { BlockField } from "@/blocks/views";
import { FieldEditor } from "@/components/field-editor";
import { KeyMenu, type KeyMenuItem } from "@/components/key-menu";
import { ModalFrame } from "@/components/modal-frame";
import { useKeyLayer } from "@/lib/keymap";
import { cn } from "@/lib/utils";
import { OTHER_OPTION, type MultichoiceState } from "@plugins/user-input";

/** One row of the answer list: an option, the built-in Other, or the note.
 *  Options and Other are checkable; the note is plain text at the bottom. */
type Row =
  | { kind: "option"; label: string; checked: boolean }
  | { kind: "other"; label: string; checked: boolean; detail?: string }
  | { kind: "note"; label: string };

function buildRows(state: MultichoiceState): Row[] {
  const rows: Row[] = state.options.map((label) => ({
    kind: "option",
    label,
    checked: state.selected.includes(label),
  }));
  const otherPicked = state.selected.includes(OTHER_OPTION);
  rows.push({
    kind: "other",
    label: OTHER_OPTION,
    checked: otherPicked,
    detail:
      otherPicked && state.other.trim() ? state.other.trim() : undefined,
  });
  rows.push({
    kind: "note",
    label: state.note.trim()
      ? `Note: ${state.note.trim()}`
      : "Note: (blank)",
  });
  return rows;
}

/** What the popup's field editor is editing right now. */
type Editor =
  | { kind: "rename"; index: number }
  | { kind: "other" }
  | { kind: "note" }
  | { kind: "add" };

/**
 * The answer dialog of a multichoice block, laid out like the block itself
 * instead of like a form: every option is a row you walk with the cursor
 * (j/k or the arrows), space toggles the current row's selection, enter
 * opens the row's own actions menu (space there selects too), e edits the
 * row's text, d deletes an option, i adds an option or the note, and
 * ctrl+enter commits and exits. Every change goes straight through
 * `onUpdate`, so the row behind the popup and the autosave never lag; the
 * popup itself holds no state of its own beyond the cursor.
 */
export function MultichoiceSelect({
  id,
  title,
  meta,
  state,
  onUpdate,
  onClose,
}: {
  id: string;
  title: string;
  meta?: string;
  state: MultichoiceState;
  /** Persist a full new state. Called once per discrete edit (a checkbox, a
   *  rename, an add, a delete, the note), never once per keystroke. */
  onUpdate: (next: MultichoiceState) => void;
  onClose: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const [menu, setMenu] = useState<"row" | "add" | null>(null);
  const [editing, setEditing] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const rows = buildRows(state);
  const index = Math.min(cursor, Math.max(rows.length - 1, 0));
  const target = rows[index];

  // Cursor movement clamps against the live row count (and wraps), so a
  // delete or add that resizes the list never strands the cursor; the
  // highlighted row stays in view, the way the block list does.
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const moveRow = (delta: number) => {
    if (rows.length === 0) return;
    setCursor((current) => {
      const next = Math.min(current, rows.length - 1) + delta;
      return (next + rows.length) % rows.length;
    });
  };

  const commit = (next: MultichoiceState) => {
    onUpdate(next);
    setError(null);
  };

  const toggleRow = (rowIndex: number) => {
    const row = rows[rowIndex];
    if (!row || row.kind === "note") return;
    const option = row.kind === "option" ? row.label : OTHER_OPTION;
    const picked = state.selected.includes(option);
    commit({
      ...state,
      selected: picked
        ? state.selected.filter((each) => each !== option)
        : [...state.selected, option],
    });
  };

  const deleteRow = (rowIndex: number) => {
    const row = rows[rowIndex];
    if (!row || row.kind !== "option") return;
    commit({
      ...state,
      options: state.options.filter((each) => each !== row.label),
      selected: state.selected.filter((each) => each !== row.label),
    });
  };

  /** Opens the field editor for whatever the cursor is on. */
  const editTarget = (row: Row | undefined) => {
    if (!row) return;
    setError(null);
    if (row.kind === "option") setEditing({ kind: "rename", index });
    else if (row.kind === "other") setEditing({ kind: "other" });
    else setEditing({ kind: "note" });
  };

  /** Commits the field editor, unless validation fails — then it stays open
   *  with the error inline, exactly like every other field in the app. */
  const submitEditor = (value: string) => {
    if (!editing) return;
    setError(null);
    const fail = (message: string) => {
      setError(message);
    };
    switch (editing.kind) {
      case "rename": {
        const row = rows[editing.index];
        if (!row || row.kind !== "option") return;
        const trimmed = value.trim();
        if (!trimmed) return; // blank keeps the current name
        if (trimmed.toLowerCase() === OTHER_OPTION.toLowerCase()) {
          fail(`"${OTHER_OPTION}" is built in; pick a different name`);
          return;
        }
        if (
          state.options.some(
            (option) =>
              option !== row.label &&
              option.toLowerCase() === trimmed.toLowerCase(),
          )
        ) {
          fail(`"${trimmed}" is already an option`);
          return;
        }
        commit({
          ...state,
          options: state.options.map((option) =>
            option === row.label ? trimmed : option,
          ),
          selected: state.selected.map((picked) =>
            picked === row.label ? trimmed : picked,
          ),
        });
        break;
      }
      case "other":
        commit({ ...state, other: value.trim() });
        break;
      case "note":
        commit({ ...state, note: value.trim() });
        break;
      case "add": {
        const trimmed = value.trim();
        if (!trimmed) {
          fail("option name is required");
          return;
        }
        if (trimmed.toLowerCase() === OTHER_OPTION.toLowerCase()) {
          fail(`"${OTHER_OPTION}" is built in and can only be answered`);
          return;
        }
        if (
          state.options.some(
            (option) => option.toLowerCase() === trimmed.toLowerCase(),
          )
        ) {
          fail(`"${trimmed}" is already an option`);
          return;
        }
        commit({ ...state, options: [...state.options, trimmed] });
        setCursor(state.options.length);
        break;
      }
    }
    setEditing(null);
  };

  useKeyLayer({
    id,
    modal: true,
    bindings: [
      {
        keys: ["ArrowDown", "j"],
        help: { keys: "↓ / j", label: "Next option" },
        run: () => moveRow(1),
      },
      {
        keys: ["ArrowUp", "k"],
        help: { keys: "↑ / k", label: "Previous option" },
        run: () => moveRow(-1),
      },
      {
        keys: [" "],
        help: { keys: "⎵", label: "Select / deselect" },
        run: () => toggleRow(index),
      },
      {
        keys: ["Enter"],
        help: { keys: "enter", label: "Option actions" },
        run: () => {
          if (!target || target.kind === "note") return;
          setError(null);
          setMenu("row");
        },
      },
      {
        keys: ["e"],
        help: { keys: "e", label: "Edit text" },
        run: () => editTarget(target),
      },
      {
        keys: ["d"],
        help: { keys: "d", label: "Delete option" },
        run: () => deleteRow(index),
      },
      {
        keys: ["i"],
        help: { keys: "i", label: "Add option / note" },
        run: () => {
          setError(null);
          setMenu("add");
        },
      },
      {
        keys: ["ctrl+enter"],
        help: { keys: "ctrl+enter", label: "Submit answer" },
        run: onClose,
      },
      {
        keys: ["Escape"],
        help: { keys: "esc", label: "Close" },
        run: onClose,
      },
    ],
    docs: [
      { keys: "⎵ / enter ⎵", label: "Select an option" },
      { keys: "e", label: "Edit text" },
      { keys: "ctrl+enter", label: "Submit answer" },
    ],
  });

  /** The row's own actions menu, opened with enter — which is how a
   *  selection is reachable twice: space directly, or enter then space. */
  const rowItems: KeyMenuItem[] = target
    ? [
        ...(target.kind === "note"
          ? []
          : [
              {
                label: target.checked ? "Deselect" : "Select",
                key: " ",
                keyLabel: "⎵",
                run: () => {
                  setMenu(null);
                  toggleRow(index);
                },
              },
            ]),
        {
          label: target.kind === "note" ? "Edit note" : "Edit text",
          key: "e",
          run: () => {
            setMenu(null);
            editTarget(target);
          },
        },
        ...(target.kind === "option"
          ? [
              {
                label: "Delete",
                key: "d",
                destructive: true,
                run: () => {
                  setMenu(null);
                  deleteRow(index);
                },
              },
            ]
          : []),
      ]
    : [];

  const editorField: BlockField | null = (() => {
    if (!editing) return null;
    switch (editing.kind) {
      case "rename": {
        const row = rows[editing.index];
        return {
          name: "option",
          label: "option text",
          value: row?.kind === "option" ? row.label : "",
        };
      }
      case "other":
        return { name: "other", label: "other text", value: state.other };
      case "note":
        return {
          name: "note",
          label: "additional note",
          value: state.note,
          multiline: true,
        };
      case "add":
        return { name: "option", label: "option text", value: "" };
    }
  })();

  return (
    <ModalFrame
      label={title}
      title={title}
      meta={meta}
      onClose={onClose}
      footer="⎵ select · enter actions · e edit text · d delete · i add option/note · ctrl+enter submit"
    >
      {/* The question reads as a block above the choices, like it does in
       *  the chat row — never as the popup title, which must stay short. */}
      <div className="border-b px-3 py-2 whitespace-pre-wrap">
        {state.prompt.trim() || "(no question yet)"}
      </div>
      <ul
        ref={listRef}
        className="max-h-[50vh] overflow-y-auto overscroll-contain py-1"
      >
        {rows.map((row, i) => (
          <li key={i} aria-current={i === index}>
            <button
              type="button"
              onMouseEnter={() => setCursor(i)}
              onClick={() => {
                if (row.kind === "note") editTarget(row);
                else toggleRow(i);
              }}
              className={cn(
                "flex w-full items-center gap-3 px-3 py-1 text-left",
                i === index && "bg-muted text-foreground",
              )}
            >
              {row.kind === "option" || row.kind === "other" ? (
                row.checked ? (
                  <SquareCheck
                    className="size-4 shrink-0 text-foreground"
                    aria-label="Selected"
                  />
                ) : (
                  <Square
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-label="Not selected"
                  />
                )
              ) : (
                <span className="w-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.kind === "other" && row.detail ? (
                <span className="max-w-[55%] truncate text-muted-foreground">
                  {row.detail}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      {menu === "row" ? (
        <KeyMenu
          id="multichoice-row-actions"
          title="Option actions"
          meta={target?.kind === "note" ? target.label : undefined}
          items={rowItems}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {menu === "add" ? (
        <KeyMenu
          id="multichoice-add"
          title="Add to answer"
          items={[
            {
              label: "Add option",
              key: "a",
              run: () => {
                setMenu(null);
                setEditing({ kind: "add" });
              },
            },
            {
              label: "Edit additional note",
              key: "n",
              run: () => {
                setMenu(null);
                setEditing({ kind: "note" });
              },
            },
          ]}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {editing && editorField ? (
        <FieldEditor
          id={`multichoice-${editing.kind}`}
          title={
            editing.kind === "add"
              ? "Add option"
              : editing.kind === "other"
                ? "Other text"
                : editing.kind === "note"
                  ? "Additional note"
                  : "Edit option"
          }
          meta={title}
          field={editorField}
          error={error}
          saving={false}
          onSubmit={(value) => submitEditor(value)}
          onCancel={() => {
            setError(null);
            setEditing(null);
          }}
        />
      ) : null}
    </ModalFrame>
  );
}