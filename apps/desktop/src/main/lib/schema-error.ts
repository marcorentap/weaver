import { ZodError } from "zod";

/**
 * Schema rejections carry their issues as JSON, which is unreadable in a row
 * or an editor. This is the one place that turns them into a sentence, so the
 * server action and the invalid-state view report failures identically.
 */
export function schemaMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
