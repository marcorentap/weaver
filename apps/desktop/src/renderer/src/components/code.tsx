import { Fragment } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { common, createLowlight } from "lowlight";
import { cn } from "@/lib/utils";
import { useSettings } from "@/lib/settings";

export { languageForPath } from "@plugins/rich-media";

/**
 * highlight.js' common language set, about forty grammars, which is every
 * language a block is likely to hold and small enough to highlight
 * synchronously while a row renders. Module-level, because the registry is
 * built once and read on every render.
 */
const lowlight = createLowlight(common);

/**
 * CodeBlock, highlighted into `hljs-*` spans that globals.css colours. An
 * unknown or unregistered grammar simply renders, just as the plain text it
 * came in as.
 *
 * `clips` caps the box at the row's clip height and clips its own overflow
 * (`max-h-full` — the parent is the bounded row), so the card's border stays
 * whole and its content truncates inside it. Inline rows opt in so the
 * row-level clip stops cutting through the card; previews leave it off and
 * scroll.
 */
export function CodeBlock({
  code,
  language,
  className,
  clips = false,
}: {
  code: string;
  language: string | null;
  className?: string;
  /** The row clips this box, so it clamps itself and hides its overflow. */
  clips?: boolean;
}) {
  const { settings } = useSettings();
  // Wrapping keeps a long line on screen; not wrapping keeps its columns.
  // Both are defensible for code, so it is the reader's choice. Horizontal
  // room is the caller's. An inline preview clips where a row scrolls.
  const classes = cn(
    "min-w-0",
    clips && "max-h-full",
    settings.wordWrap === "on"
      ? "whitespace-pre-wrap break-words"
      : "whitespace-pre",
    className,
  );
  // `data-clip` lets the enclosing row read this card's own scrollHeight
  // to decide whether it is truncated, since the capped box hides the
  // overflow the wrapper alone would have seen.
  return (
    <pre data-clip={clips ? "1" : undefined} className={classes}>
      {!language || !lowlight.registered(language)
        ? code
        : toJsxRuntime(lowlight.highlight(language, code), {
            Fragment,
            jsx,
            jsxs,
          })}
    </pre>
  );
}
