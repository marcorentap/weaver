"use client";

import { Fragment } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { common, createLowlight } from "lowlight";
import { cn } from "@/lib/utils";
import { useSettings } from "@/lib/settings";

export { languageForPath } from "@/lib/languages";

/**
 * highlight.js' common language set: about forty grammars, which is every
 * language a block is likely to hold and small enough to highlight
 * synchronously while a row renders. Module-level, because the registry is
 * built once and read on every render.
 */
const lowlight = createLowlight(common);

/**
 * Code, highlighted into `hljs-*` spans that globals.css colours. An unknown
 * or unregistered grammar still renders — as the plain text it came in as.
 */
export function CodeBlock({
  code,
  language,
  className,
}: {
  code: string;
  language: string | null;
  className?: string;
}) {
  const { settings } = useSettings();
  // Wrapping keeps a long line on screen; not wrapping keeps its columns.
  // Both are defensible for code, so it is the reader's choice. Horizontal
  // room is the caller's: an inline preview clips where a row scrolls.
  const classes = cn(
    "min-w-0",
    settings.wordWrap === "on"
      ? "whitespace-pre-wrap break-words"
      : "whitespace-pre",
    className,
  );
  if (!language || !lowlight.registered(language)) {
    return <pre className={classes}>{code}</pre>;
  }
  return (
    <pre className={classes}>
      {toJsxRuntime(lowlight.highlight(language, code), {
        Fragment,
        jsx,
        jsxs,
      })}
    </pre>
  );
}
