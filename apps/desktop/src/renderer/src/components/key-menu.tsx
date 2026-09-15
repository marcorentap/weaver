import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { ModalFrame } from "@/components/modal-frame";
import { useKeyLayer } from "@/lib/keymap";
import { cn } from "@/lib/utils";

export type KeyMenuItem = {
  label: string;
  /** Extra column, e.g. a timestamp or an id. */
  detail?: string;
  /** Optional direct shortcut, on top of arrow keys plus enter. */
  key?: string;
  /** When true the item reads as locked: dimmed with a lock glyph, skipped
   *  by cursor navigation, and its key and enter both no-op — shown rather
   *  than removed so the row it guards stays visible while a sibling
   *  action is in flight. */
  disabled?: boolean;
  /** How `key` reads as a label, for keys that aren't a printable
   *  character — the space bar is `" "` at the keyboard but `"⎵"` in the
   *  gutter and help. */
  keyLabel?: string;
  destructive?: boolean;
  run: () => void;
};

/**
 * A keyboard-only popup, the modal layer a page's normal mode enters.
 * It owns no focus management, since every key goes through the keymap stack
 * rather than the DOM's focus ring.
 */
export function KeyMenu({
  id,
  title,
  meta,
  items,
  hint,
  onClose,
}: {
  id: string;
  title: string;
  meta?: string;
  items: KeyMenuItem[];
  /** A dim line under the menu, for keys the menu itself doesn't own, e.g.
   *  "NUM — switch to a tab". */
  hint?: string;
  onClose: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const index = Math.min(cursor, Math.max(items.length - 1, 0));
  const listRef = useRef<HTMLUListElement>(null);

  // The list itself scrolls (``max-h-72 overflow-y-auto`` below), but j/k
  // only move the cursor; without this the highlighted row walks off screen
  // in a long menu (recent sessions) and the wheel is the only way back.
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const move = (delta: number) => {
    if (items.length === 0) return;
    setCursor((current) => {
      if (items.every((item) => item.disabled)) return current;
      let next = Math.min(current, items.length - 1) + delta;
      // Hop over disabled rows, so the cursor never rests on an action
      // enter cannot run. Wraps, and stays put if everything is locked.
      for (let i = 0; i < items.length; i++) {
        next = ((next % items.length) + items.length) % items.length;
        if (!items[next]?.disabled) return next;
        next += delta;
      }
      return current;
    });
  };

  useKeyLayer({
    id,
    modal: true,
    bindings: [
      {
        keys: ["ArrowDown", "j"],
        help: [{ keys: "↓ / j", label: "Next item" }],
        run: () => move(1),
      },
      {
        keys: ["ArrowUp", "k"],
        help: [{ keys: "↑ / k", label: "Previous item" }],
        run: () => move(-1),
      },
      {
        keys: ["Enter"],
        help: [{ keys: "enter", label: "Run selected item" }],
        run: () => (items[index]?.disabled ? undefined : items[index]?.run()),
      },
      {
        keys: ["Escape"],
        help: [{ keys: "esc", label: "Close" }],
        run: onClose,
      },
      ...items.flatMap((item) =>
        item.key
          ? [
              {
                keys: [item.key],
                help: [{
                  keys: item.keyLabel ?? item.key,
                  label: item.label,
                }],
                run: item.disabled ? () => {} : item.run,
              },
            ]
          : [],
      ),
    ],
  });

  return (
    <ModalFrame
      label={title}
      title={title}
      meta={meta}
      onClose={onClose}
      footer={hint}
    >
      <ul ref={listRef} className="max-h-72 overflow-y-auto overscroll-contain py-1">
          {items.length === 0 ? (
            <li className="px-3 py-1 text-muted-foreground">Nothing here</li>
          ) : (
            items.map((item, i) => (
              <li key={item.label} aria-current={i === index}>
                <button
                  type="button"
                  disabled={item.disabled}
                  // Hovering moves the cursor, so the pointer and the keyboard
                  // never disagree about which item is selected. A disabled
                  // row isn't selectable, so hovering it leaves the cursor.
                  onMouseEnter={() => !item.disabled && setCursor(i)}
                  onClick={item.run}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-1 text-left",
                    i === index && "bg-muted text-foreground",
                    item.destructive && "text-destructive",
                    item.disabled &&
                      "cursor-not-allowed opacity-60 text-muted-foreground",
                  )}
                >
                  <span className="w-8 shrink-0 text-muted-foreground">
                    {item.disabled ? (
                      <Lock className="size-3" />
                    ) : (
                      item.keyLabel ?? item.key ?? " "
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.detail ? (
                    // A short id or a long value, both a gray preview on the
                    // right. Truncates rather than outgrowing its row, so a
                    // media block's huge text reads as a preview, not a flood.
                    <span className="max-w-[55%] truncate text-muted-foreground">
                      {item.detail}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
      </ul>
    </ModalFrame>
  );
}
