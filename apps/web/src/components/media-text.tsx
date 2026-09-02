"use client";

import { useEffect, useState } from "react";
import { MarkdownText } from "@/components/markdown";
import { cn } from "@/lib/utils";

type Load =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; message: string };

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
        {load.status === "loading" ? "Loading…" : load.message}
      </span>
    );
  }

  // Overflow is the caller's call: inline rows clip, previews scroll.
  if (markdown) {
    return (
      <MarkdownText text={load.text} className={cn("border p-2", className)} />
    );
  }

  return (
    <pre className={cn("whitespace-pre border p-2", className)}>
      {load.text}
    </pre>
  );
}
