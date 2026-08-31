"use client";

import { useEffect, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

type Load =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; message: string };

/**
 * Markdown keeps the rail's type scale — everything is `text-xs`, so structure
 * comes from weight, rules and indentation rather than from heading sizes.
 * Raw HTML in the source is not rendered: react-markdown drops it unless
 * rehype-raw is added, and a media block points at files we do not control.
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
  ul: (props) => <ul {...props} className="mt-2 list-disc pl-4" />,
  ol: (props) => <ol {...props} className="mt-2 list-decimal pl-4" />,
  li: (props) => <li {...props} className="mt-0.5" />,
  blockquote: (props) => (
    <blockquote
      {...props}
      className="mt-2 border-l-2 pl-2 text-muted-foreground"
    />
  ),
  code: (props) => <code {...props} className="bg-muted px-1" />,
  pre: (props) => (
    <pre {...props} className="mt-2 overflow-x-auto border p-2" />
  ),
  hr: (props) => <hr {...props} className="my-3" />,
  table: (props) => <table {...props} className="mt-2 border" />,
  th: (props) => <th {...props} className="border px-1 text-left font-medium" />,
  td: (props) => <td {...props} className="border px-1 align-top" />,
  img: (props) => (
    // Remote, arbitrary source: next/image cannot serve it.
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img {...props} className="max-h-48 w-auto" />
  ),
};

/**
 * A text file's contents, fetched lazily. Text blocks are the one media type
 * with nothing to hand a DOM element: the bytes have to be read before there
 * is anything to show, so the row starts empty and fills in.
 */
export function MediaText({
  src,
  markdown = false,
  className,
}: {
  src: string;
  /** Render structure instead of the literal characters. */
  markdown?: boolean;
  className?: string;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    const abort = new AbortController();

    void (async () => {
      try {
        // Reset inside the fetch, not on the way into the effect: the previous
        // file stays on screen until the new one is actually being read.
        setLoad({ status: "loading" });
        const response = await fetch(src, { signal: abort.signal });
        if (!response.ok) {
          setLoad({
            status: "error",
            message: `${response.status} ${response.statusText}`,
          });
          return;
        }
        setLoad({ status: "ready", text: await response.text() });
      } catch (cause) {
        // An abort is this effect being cleaned up, not a failed read.
        if (abort.signal.aborted) return;
        setLoad({ status: "error", message: String(cause) });
      }
    })();

    return () => abort.abort();
  }, [src]);

  if (load.status !== "ready") {
    return (
      <span className="shrink-0 text-muted-foreground">
        {load.status === "loading" ? "loading…" : load.message}
      </span>
    );
  }

  // Overflow is the caller's call: inline rows clip, previews scroll.
  if (markdown) {
    return (
      <div className={cn("border p-2", className)}>
        <Markdown components={MARKDOWN} remarkPlugins={[remarkGfm]}>
          {load.text}
        </Markdown>
      </div>
    );
  }

  return (
    <pre className={cn("whitespace-pre border p-2", className)}>
      {load.text}
    </pre>
  );
}
