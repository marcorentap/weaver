import { cn } from "@/lib/utils";

/**
 * The number column along a block row's left edge. Kept as its own element so
 * the gutter can grow later — icon toggles, fold state, breakpoints — without
 * touching the row layout itself.
 */
export function Gutter({
  line,
  show,
  className,
}: {
  /** The line number to display; null hides the cell entirely. */
  line: number | null;
  /** Whether to render at all; used before the stored setting is hydrated. */
  show: boolean;
  className?: string;
}) {
  // tabular-nums keeps 1..N and -1..-N from jittering as they change.
  // line === 0 (the current row in relative mode) reads as the anchor, so it
  // is brightened while the rest stay muted.
  return (
    <span
      aria-hidden={line === null || !show}
      className={cn(
        "w-8 shrink-0 select-none text-right tabular-nums",
        show && line !== null
          ? line === 0
            ? "text-foreground/80"
            : "text-muted-foreground"
          : "",
        className,
      )}
    >
      {show && line !== null ? line : ""}
    </span>
  );
}