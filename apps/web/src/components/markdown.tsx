"use client";

import Markdown, {
  type Components,
  defaultUrlTransform,
} from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { mediaSrc, parseMediaUri } from "@/blocks/media";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * Module-level so the pipeline is not rebuilt on every render. `remark-breaks`
 * turns a bare newline into `<br>`, matching a chat message's own line breaks
 * instead of CommonMark's "needs two"; `remark-math` picks `$...$` and
 * `$$...$$` out as math nodes for `rehype-katex` to render below.
 */
const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkMath];

/**
 * Fenced code is highlighted by the same highlight.js grammars a read tool's
 * own preview uses; math nodes `remark-math` produced render as real KaTeX
 * markup, not literal `$...$` — its stylesheet is imported once in
 * `globals.css`, ahead of Tailwind's own import.
 */
const REHYPE_PLUGINS = [rehypeHighlight, rehypeKatex];

/**
 * A fenced block, wrapped or scrolled per the word wrap setting. It is its own
 * component because that choice comes from settings, and a component in the
 * map below can read them.
 */
function Pre({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"pre">) {
  const { settings } = useSettings();
  return (
    <pre
      {...props}
      className={cn(
        className,
        // Plain class marker, not a Tailwind utility: globals.css uses it
        // to strip the inline-code background back off the `<code>` this
        // wraps (see the `code` renderer below).
        "md-fenced-block",
        "mt-2 overflow-x-auto border p-2",
        settings.wordWrap === "on" ? "whitespace-pre-wrap break-words" : "",
      )}
    />
  );
}

/**
 * react-markdown drops every URL whose scheme is not http, https, mailto or
 * tel, which would silently blank an image the harness can actually serve: a
 * local file is exactly what an agent has to show. `file:` is let through and
 * resolved by `mediaSrc`; everything else keeps the default filter, so
 * `javascript:` stays dead.
 */
const urlTransform = (url: string) =>
  url.startsWith("file:") ? url : defaultUrlTransform(url);

/**
 * Markdown keeps the rail's type scale — everything is `text-xs`, so structure
 * comes from weight, rules and indentation rather than from heading sizes.
 * Raw HTML in the source is not rendered: react-markdown drops it unless
 * rehype-raw is added, and the text can come from a file or a model.
 */
const MARKDOWN: Components = {
  h1: (props) => <h1 {...props} className="mt-3 font-semibold first:mt-0" />,
  h2: (props) => <h2 {...props} className="mt-3 font-semibold first:mt-0" />,
  h3: (props) => <h3 {...props} className="mt-3 font-medium first:mt-0" />,
  h4: (props) => <h4 {...props} className="mt-3 font-medium first:mt-0" />,
  p: (props) => <p {...props} className="mt-2 first:mt-0" />,
  a: (props) => (
    <a {...props} target="_blank" rel="noreferrer" className="underline" />
  ),
  ul: (props) => <ul {...props} className="mt-2 list-disc list-inside pl-4" />,
  ol: (props) => <ol {...props} className="mt-2 list-decimal list-inside pl-4" />,
  li: (props) => <li {...props} className="mt-0.5" />,
  blockquote: (props) => (
    <blockquote
      {...props}
      className="mt-2 border-l pl-2 text-muted-foreground"
    />
  ),
  // Always styled as inline code; globals.css strips this back off for a
  // fenced block's `<code>` (marked via `Pre`'s `md-fenced-block` class),
  // since a `className`-presence check isn't reliable there — a fenced
  // block with no language `rehype-highlight` can identify gets no class
  // at all, so it fell through as "inline" and kept the gray background
  // this was meant to remove.
  code: ({ className, ...props }) => (
    <code {...props} className={cn(className, "bg-muted px-1")} />
  ),
  pre: Pre,
  hr: (props) => <hr {...props} className="my-3" />,
  table: (props) => <table {...props} className="mt-2 border" />,
  th: (props) => <th {...props} className="border px-1 text-left font-medium" />,
  td: (props) => <td {...props} className="border px-1 align-top" />,
  img: ({ src, ...props }) => (
    // A `file://` image, and any cross-origin one, is only loadable through
    // the media route, so an embedded image resolves the same way a media
    // block's URI does. Anything else — a site-relative path, a data URI —
    // is left for the browser to resolve.
    // Remote, arbitrary source: next/image cannot serve it.
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img
      {...props}
      src={
        typeof src === "string" && parseMediaUri(src) ? mediaSrc(src) : src
      }
      className="mt-2 max-h-48 w-auto"
    />
  ),
};

/** Markdown, rendered at the rail's scale. */
export function MarkdownText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <Markdown
        components={MARKDOWN}
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={urlTransform}
      >
        {text}
      </Markdown>
    </div>
  );
}
