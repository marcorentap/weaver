"use client";

import { ModalFrame } from "@/components/modal-frame";
import { HELP_KEY } from "@/lib/keymap";

export type HelpLayer = {
  /** Mode name. */
  id: string;
  bindings: { keys: string; label: string }[];
};

/**
 * Help for the current mode. Keybindings are one section of it, listed
 * innermost mode first; only reachable layers are passed in, so nothing here
 * is a key that would be swallowed.
 */
export function KeyHelp({
  layers,
  onClose,
}: {
  layers: HelpLayer[];
  onClose: () => void;
}) {
  return (
    <ModalFrame
      label="help"
      title="help"
      meta={layers.map((layer) => layer.id).join(" › ")}
      footer={`${HELP_KEY} or esc close`}
      onClose={onClose}
    >
      <div className="max-h-96 overflow-y-auto pb-1">
        <h2 className="border-b px-3 py-0.5 font-medium">keybindings</h2>
        {layers
          .slice()
          .reverse()
          .map((layer) => (
            <section key={layer.id}>
              <h3 className="px-3 pt-1 text-muted-foreground">{layer.id}</h3>
              <ul>
                {layer.bindings.map((binding) => (
                  <li key={binding.keys} className="flex gap-3 px-3 py-0.5">
                    <span className="w-16 shrink-0 font-medium">
                      {binding.keys}
                    </span>
                    <span className="min-w-0 truncate">{binding.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </div>
    </ModalFrame>
  );
}
