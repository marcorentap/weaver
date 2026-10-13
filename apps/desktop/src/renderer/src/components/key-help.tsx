import { KeyMenu, type KeyMenuItem } from "@/components/key-menu";
import { HELP_KEY, HELP_LAYER_ID } from "@/lib/keymap";

export type HelpLayer = {
  /** Mode name. */
  id: string;
  bindings: {
    keys: string;
    label: string;
    /** A second column on the right, the same slot a session row gives a
     *  timestamp or an id. */
    detail?: string;
  }[];
};

/**
 * Help for the current mode, as the menu every other popup is: one scrolling
 * list of rows — a key column, a label, a right-hand detail — with a cursor
 * that j/k or the arrows walk, hover following it, and the selected row
 * highlighted. Layer names are menu headings rather than a second kind of
 * section, so the popup is a single list from top to bottom.
 *
 * The rows document bindings rather than actions: each one shows its chord in
 * the key column but binds nothing (`keyLabel` without `key`), and has no
 * `run`, so entering help to read it can never fire the page's own action
 * underneath. Reading is all the cursor is for here.
 *
 * Bindings are listed innermost mode first; only reachable layers are passed
 * in, so nothing here is a key that would be swallowed.
 */
export function KeyHelp({
  layers,
  onClose,
}: {
  layers: HelpLayer[];
  onClose: () => void;
}) {
  const items: KeyMenuItem[] = layers
    .slice()
    .reverse()
    .flatMap((layer) => [
      { heading: layer.id },
      ...layer.bindings.map((binding) => ({
        keyLabel: binding.keys,
        label: binding.label,
        detail: binding.detail,
      })),
    ]);

  return (
    <KeyMenu
      id={HELP_LAYER_ID}
      title="Help"
      meta={layers.map((layer) => layer.id).join(" › ")}
      items={items}
      keyWidth="w-32"
      hint={`${HELP_KEY} or esc Close`}
      onClose={onClose}
    />
  );
}
