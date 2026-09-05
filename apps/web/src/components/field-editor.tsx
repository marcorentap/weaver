"use client";

import { useState } from "react";
import type { BlockField } from "@/blocks/views";
import { ModalFrame } from "@/components/modal-frame";
import { useKeyLayer } from "@/lib/keymap";

/**
 * Edits one field a kind declared. The input owns its keys — the keymap
 * ignores events from text entry — so enter and escape are handled here and
 * only documented in help.
 */
export function FieldEditor({
  id,
  title,
  meta,
  field,
  error,
  saving,
  onSubmit,
  onCancel,
}: {
  id: string;
  title: string;
  /** Extra header context, distinct from `title` — which field this is
   *  editing, say. Omit when the title alone already says everything (a
   *  "New session" dialog doesn't need "name" tacked on beside it). */
  meta?: string;
  field: BlockField;
  error: string | null;
  saving: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(field.value);

  useKeyLayer({
    id,
    modal: true,
    bindings: [
      // Live only while focus is outside the input, which handles its own keys.
      {
        keys: ["Escape"],
        help: { keys: "esc", label: "Cancel" },
        run: onCancel,
      },
    ],
    docs: field.multiline
      ? [
          { keys: "enter", label: "New line" },
          { keys: "ctrl+enter", label: `Save ${field.label}` },
        ]
      : [{ keys: "enter", label: `Save ${field.label}` }],
  });

  return (
    <ModalFrame
      label={title}
      title={title}
      meta={meta}
      size={field.multiline ? "lg" : undefined}
      onClose={onCancel}
    >
      <div className="space-y-1 px-3 py-2">
        {field.multiline ? (
          <textarea
            // Content, so enter belongs to the text and saving moves to
            // ctrl/cmd+enter — the same trade every message box makes.
            autoFocus
            rows={16}
            value={value}
            disabled={saving}
            placeholder={field.placeholder}
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                onSubmit(value);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
              }
            }}
            className="w-full resize-y border bg-background px-2 py-1 font-mono outline-none placeholder:text-muted-foreground/50 focus:border-foreground/40 disabled:opacity-50"
          />
        ) : (
          <input
            // The only place in the app where typing beats modal keys.
            autoFocus
            value={value}
            disabled={saving}
            placeholder={field.placeholder}
            inputMode={field.type === "number" ? "decimal" : "text"}
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSubmit(value);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
              }
            }}
            className="w-full border bg-background px-2 py-1 outline-none placeholder:text-muted-foreground/50 focus:border-foreground/40 disabled:opacity-50"
          />
        )}
        {error ? <p className="text-destructive">{error}</p> : null}
      </div>
    </ModalFrame>
  );
}
