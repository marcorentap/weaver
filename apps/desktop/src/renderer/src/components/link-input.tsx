import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import type { LinkOption } from "@shared/ipc-contract.js";
import { fuzzyFilter } from "@shared/fuzzy.js";
import { searchLinkOptions, useLinkTypes } from "@/lib/links";
import { cn } from "@/lib/utils";

/** Most entries to offer at once. A menu longer than this stops being
 *  scannable, and the query is meant to narrow it anyway. */
const MAX_ITEMS = 12;

/** Wait this long after a keystroke before asking the provider. Matches the
 *  rhythm of typing without a round trip per character. */
const DEBOUNCE_MS = 120;

/**
 * The `@…` token the caret is sitting in. `valueQuery` is `undefined` while
 * only the type is being typed (no `:` yet), which is what tells the menu
 * to complete the type half; once a `:` exists it holds the text after it
 * (possibly empty), and the menu completes the value half.
 */
type Token = {
  /** Index of the leading `@` in the value. */
  start: number;
  /** Caret position, i.e. the end of the token being typed. */
  end: number;
  typeId: string;
  valueQuery: string | undefined;
};

/** Locate the token ending at `caret`, or null. A token only starts at a
 *  word boundary — line start or whitespace before the `@` — so an email
 *  address or an `@` inside a word never opens the menu. Link characters
 *  are deliberately conservative (no spaces), which keeps the token easy to
 *  re-derive on every caret move. */
function tokenAt(text: string, caret: number): Token | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([A-Za-z0-9_-]*)(?::([^\s]*))?$/.exec(before);
  if (!match) return null;
  const lead = match[1] ?? "";
  return {
    start: before.length - match[0].length + lead.length,
    end: caret,
    typeId: match[2] ?? "",
    valueQuery: match[3],
  };
}

/** Stable empty list, so `items`' memo does not see a fresh array on every
 *  render while no value search has resolved. */
const NO_OPTIONS: LinkOption[] = [];

/** One row of the menu, already resolved to what accepting it does. */
type Item = {
  key: string;
  label: string;
  detail?: string;
  /** `type` writes `@id:` and stays open for the value; `expand` writes the
   *  whole `@id:value` with no trailing space and stays open, because the
   *  value nests (a directory); `option` writes the whole link with a
   *  trailing space and closes it. */
  part: "type" | "expand" | "option";
  value: string;
};

/**
 * A message textarea with `@`-link completion: `@<type>:<value>` written
 * inline, both halves fuzzy-searched. Typing `@` lists the available types;
 * picking one opens its value list (`@file:` → project files, `@skill:` →
 * discovered skills). It replaces the plain textarea of the user block's
 * message field; every other field keeps `FieldEditor`'s bare input.
 *
 * The two halves come from different places — the type list once at mount,
 * the values per query from the main process — so the menu owns the pending
 * half in local state and never assumes the other has resolved.
 */
export function LinkInput({
  value,
  onChange,
  onSubmit,
  onSubmitShift,
  onCancel,
  disabled,
  placeholder,
  pwd,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Save (ctrl/cmd+enter), matching a plain message textarea. */
  onSubmit: (value: string) => void;
  /** Save and open the custom inference dialog (ctrl/cmd+shift+enter). */
  onSubmitShift?: (value: string) => void;
  onCancel: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** The `WEAVER_PWD` of the merged environment at the message being
   *  written (see `pwdForBlock`/`pwdForPosition`). It roots a `@file:`
   *  search in the message's own project, so the menu tracks the block the
   *  way an inference run there would. Undefined falls back to the process's
   *  project root. */
  pwd?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { types, failed: typesFailed } = useLinkTypes();

  const [caret, setCaret] = useState(value.length);
  /** The highlighted row, paired with the value it was chosen for. A new
   *  value (the user typing) no longer matches, which resets the highlight
   *  to the top without an effect. */
  const [pick, setPick] = useState<{ value: string; index: number }>({
    value,
    index: 0,
  });
  /** Value options with the query they answered, so a slow search cannot
   *  show the previous type's results while the next one is in flight. The
   *  root is tagged too: a `pwd` change re-roots the search. `failed`
   *  distinguishes a rejected search from a search that found nothing —
   *  both leave `options` empty, and only one is worth telling the user. */
  const [results, setResults] = useState<{
    typeId: string;
    query: string;
    pwd: string | undefined;
    options: LinkOption[];
    failed: boolean;
  } | null>(null);
  /** Signature of the token esc dismissed, so it stays closed while the
   *  caret sits in that same token and reopens as soon as it changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);

  const token = useMemo(() => tokenAt(value, caret), [value, caret]);
  const signature = token
    ? `${token.start}:${token.typeId}:${token.valueQuery === undefined ? "-" : token.valueQuery}`
    : null;

  // Type mode: the type list, filtered locally (it is small and already in
  // memory). Value mode: the provider's options, fetched below.
  const typeMatches = useMemo(
    () =>
      token && token.valueQuery === undefined
        ? fuzzyFilter(
            token.typeId,
            types,
            (type) => `${type.id} ${type.label} ${type.description}`,
            MAX_ITEMS,
          )
        : [],
    [token, types],
  );

  const typeId = token && token.valueQuery !== undefined ? token.typeId : null;
  const valueQuery = token?.valueQuery;
  useEffect(() => {
    if (typeId === null || valueQuery === undefined) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchLinkOptions(typeId, valueQuery, pwd)
        .then((options) => {
          if (!cancelled)
            setResults({
              typeId,
              query: valueQuery,
              pwd,
              options,
              failed: false,
            });
        })
        .catch(() => {
          if (!cancelled)
            setResults({
              typeId,
              query: valueQuery,
              pwd,
              options: [],
              failed: true,
            });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [typeId, valueQuery, pwd]);

  const resolved =
    results &&
    results.typeId === typeId &&
    results.query === valueQuery &&
    results.pwd === pwd
      ? results
      : null;
  const options = resolved?.options ?? NO_OPTIONS;
  const loading = typeId !== null && resolved === null;
  const failed = resolved?.failed ?? false;

  const items: Item[] = useMemo(() => {
    if (!token) return [];
    if (token.valueQuery === undefined) {
      return typeMatches.map((type) => ({
        key: type.id,
        label: `@${type.id}`,
        detail: type.description,
        part: "type" as const,
        value: type.id,
      }));
    }
    return options.map((option) => ({
      key: `${option.label ?? option.value}\u0000${option.value}`,
      label: option.label ?? option.value,
      detail: option.detail,
      part: option.expand ? ("expand" as const) : ("option" as const),
      value: option.value,
    }));
  }, [token, typeMatches, options]);

  // A new query starts a new menu; keep the highlight on the best match.
  const selected = pick.value === value ? pick.index : 0;

  const open =
    signature !== null && signature !== dismissed && items.length > 0;
  const active = items.length > 0 ? Math.min(selected, items.length - 1) : 0;

  /** What the menu says instead of rows: a fetch in flight, or a failure
   *  worth naming. Silence would be read as "no matches", which is a
   *  different thing from a provider that never answered. */
  const notice =
    open || token === null
      ? null
      : typeId !== null
        ? failed
          ? "link search failed"
          : loading
            ? "searching…"
            : null
        : typesFailed
          ? "link types unavailable"
          : null;

  const commit = (item: Item) => {
    if (!token) return;
    const staysOpen = item.part !== "option";
    const replacement =
      item.part === "type"
        ? `@${item.value}:`
        : `@${token.typeId}:${item.value}${staysOpen ? "" : " "}`;
    const nextValue =
      value.slice(0, token.start) + replacement + value.slice(token.end);
    const nextCaret = token.start + replacement.length;
    onChange(nextValue);
    setDismissed(null);
    setPick({ value: nextValue, index: 0 });
    // React has not painted the new value yet, so move the caret after it
    // settles; otherwise the next keystroke would land at the old offset.
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  const syncCaret = () => {
    setCaret(ref.current?.selectionStart ?? 0);
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setCaret(event.target.selectionStart ?? event.target.value.length);
    onChange(event.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setPick({ value, index: (selected + 1) % items.length });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setPick({
          value,
          index: (selected - 1 + items.length) % items.length,
        });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        commit(items[active] as Item);
        return;
      }
      if (event.key === "Escape") {
        // Close the menu only; a second escape leaves the dialog.
        event.preventDefault();
        setDismissed(signature);
        return;
      }
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (event.shiftKey && onSubmitShift) onSubmitShift(value);
      else onSubmit(value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        autoFocus
        rows={16}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={syncCaret}
        onSelect={syncCaret}
        onClick={syncCaret}
        className="w-full resize-y border bg-background px-2 py-1 font-mono outline-none placeholder:text-muted-foreground/50 focus:border-foreground/40 disabled:opacity-50"
      />
      {open ? (
        <ul
          role="listbox"
          className="absolute top-full right-0 left-0 z-10 mt-1 max-h-64 overflow-auto border bg-background shadow-lg"
        >
          {items.map((item, index) => (
            <li
              key={item.key}
              role="option"
              aria-selected={index === active}
              // Mouse-down rather than click so the textarea never loses
              // focus and the caret we are about to write at stays valid.
              onMouseDown={(event) => {
                event.preventDefault();
                commit(item);
              }}
              className={cn(
                "flex cursor-pointer items-baseline gap-2 px-2 py-1",
                index === active ? "bg-accent" : "",
              )}
            >
              <span className="shrink-0 font-mono">{item.label}</span>
              {item.detail ? (
                <span className="min-w-0 truncate text-muted-foreground">
                  {item.detail}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : notice ? (
        <div
          className={cn(
            "absolute top-full right-0 left-0 z-10 mt-1 border bg-background px-2 py-1 shadow-lg",
            notice === "searching…"
              ? "text-muted-foreground"
              : "text-destructive",
          )}
        >
          {notice}
        </div>
      ) : null}
    </div>
  );
}
