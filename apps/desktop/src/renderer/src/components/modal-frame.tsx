import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared chrome for every keyboard popup: help, menus, field edits, previews.
 * Focus is never trapped here, except where a popup renders a real input.
 * Keys are dispatched by the keymap stack, not by the DOM focus ring.
 */
export function ModalFrame({
  label,
  title,
  meta,
  footer,
  size = "lg",
  onClose,
  children,
}: {
  label: string;
  title: string;
  meta?: ReactNode;
  footer?: ReactNode;
  /** The default `lg` matches the preview popup's width, so every popup
   *  shares the same frame; `xl` is for wide dialogs like the settings-style
   *  custom inference form. */
  size?: "md" | "lg" | "xl";
  /** Clicking the backdrop leaves the mode, the same as the popup's esc. */
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      // Only a click that lands on the backdrop itself closes; clicks inside
      // the dialog bubble through here too.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      // `overscroll-contain` on a scroll container of its own. Without it a
      // wheel past the end of the popup keeps going into the page behind.
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden overscroll-contain bg-background/70 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cn(
          "w-full border bg-background",
          size === "lg"
            ? "max-w-3xl"
            : size === "xl"
              ? "max-w-5xl"
              : "max-w-md",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
          <span className="min-w-0 truncate font-medium">{title}</span>
          {meta ? (
            <span className="shrink-0 truncate text-muted-foreground">
              {meta}
            </span>
          ) : null}
        </div>

        {children}

        {footer ? (
          <div className="border-t px-3 py-1 text-muted-foreground">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
