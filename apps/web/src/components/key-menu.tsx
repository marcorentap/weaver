"use client";

import { useState } from "react";
import { ModalFrame } from "@/components/modal-frame";
import { useKeyLayer } from "@/lib/keymap";
import { cn } from "@/lib/utils";

export type KeyMenuItem = {
  label: string;
  /** Extra column, e.g. a timestamp or an id. */
  detail?: string;
  /** Optional direct shortcut, on top of arrow keys plus enter. */
  key?: string;
  destructive?: boolean;
  run: () => void;
};

/**
 * A keyboard-only popup: the modal mode entered from a page's normal mode.
 * It owns no focus management, since every key goes through the keymap stack
 * rather than the DOM's focus ring.
 */
export function KeyMenu({
  id,
  title,
  items,
  onClose,
}: {
  id: string;
  title: string;
  items: KeyMenuItem[];
  onClose: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const index = Math.min(cursor, Math.max(items.length - 1, 0));

  const move = (delta: number) => {
    if (items.length === 0) return;
    setCursor((current) => {
      const next = Math.min(current, items.length - 1) + delta;
      return (next + items.length) % items.length;
    });
  };

  useKeyLayer({
    id,
    modal: true,
    bindings: [
      {
        keys: ["ArrowDown", "j"],
        help: { keys: "↓ / j", label: "next item" },
        run: () => move(1),
      },
      {
        keys: ["ArrowUp", "k"],
        help: { keys: "↑ / k", label: "previous item" },
        run: () => move(-1),
      },
      {
        keys: ["Enter"],
        help: { keys: "enter", label: "run selected item" },
        run: () => items[index]?.run(),
      },
      {
        keys: ["Escape"],
        help: { keys: "esc", label: "close" },
        run: onClose,
      },
      ...items.flatMap((item) =>
        item.key
          ? [
              {
                keys: [item.key],
                help: { keys: item.key, label: item.label },
                run: item.run,
              },
            ]
          : [],
      ),
    ],
  });

  return (
    <ModalFrame label={title} title={title} onClose={onClose}>
      <ul className="max-h-72 overflow-y-auto overscroll-contain py-1">
          {items.length === 0 ? (
            <li className="px-3 py-1 text-muted-foreground">nothing here</li>
          ) : (
            items.map((item, i) => (
              <li key={item.label} aria-current={i === index}>
                <button
                  type="button"
                  // Hovering moves the cursor, so the pointer and the keyboard
                  // never disagree about which item is selected.
                  onMouseEnter={() => setCursor(i)}
                  onClick={item.run}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-1 text-left",
                    i === index && "bg-muted text-foreground",
                    item.destructive && "text-destructive",
                  )}
                >
                  <span className="w-3 shrink-0 text-muted-foreground">
                    {item.key ?? " "}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.detail ? (
                    <span className="shrink-0 text-muted-foreground">
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
