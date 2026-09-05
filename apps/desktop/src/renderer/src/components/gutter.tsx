import { cn } from "@/lib/utils";

/**
 * The number column along a block row's left edge. Kept as its own element so
 * the gutter can grow later — icon toggles, fold state, breakpoints — without
 * touching the row layout itself.
 */
export function Gutter({
  line,
  show,
  current,
  className,
}: {
  /** The line number to display; null hides the cell entirely. */
  line: number | null;
  /** Whether to render at all; used before the stored setting is hydrated. */
  show: boolean;
  /** The selected row: brightened, regardless of which number it shows. */
  current: boolean;
  className?: string;
}) {
  // tabular-nums keeps 1..N and -1..-N from jittering as they change.
  return (
    <span
      aria-hidden={line === null || !show}
      className={cn(
        "w-8 shrink-0 select-none text-right tabular-nums",
        show && line !== null
          ? current
            ? "text-foreground"
            : "text-muted-foreground"
          : "",
        className,
      )}
    >
      {show && line !== null ? line : ""}
    </span>
  );
}
