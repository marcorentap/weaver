import { z } from "zod";
import type { ContextImage } from "@repo/core";
import { defineKind } from "@repo/core";
import { languageForPath } from "../../languages.ts";

/**
 * One tool call an agent made. An agent run does not produce a single string
 * of output; it produces a sequence of typed steps, and this is the step type
 * for "the agent called a tool": which tool, the arguments it was called with,
 * and whatever it printed back. Giving that its own kind is what lets a run
 * materialize as blocks a later run can read as context, instead of prose
 * about a call that nothing can inspect.
 */
export const TOOL_KIND = "tool";

export const toolState = z.object({
  /** Tool name as the agent invoked it, e.g. "read" or "bash". */
  name: z.string(),
  /** JSON-encoded arguments object, or "" for a call that took none. */
  args: z.string(),
  /** Everything the call printed, verbatim. Often multi-line and long. */
  output: z.string(),
  /** False when the tool reported an error, which makes `output` the failure
   *  rather than a result. */
  ok: z.boolean(),
  /**
   * The assistant message of the run that made this call, as that run named
   * it; omitted for a block written before this was recorded, and for a call
   * whose run could not say.
   *
   * Two calls in a row in the graph look the same whether the model asked for
   * both in one message or asked for one, read the result, and asked for the
   * next. Only the run saw which, and the difference is the difference between
   * a replayed request matching the one that was sent and matching nothing
   * from that call on. It is opaque: nothing reads its value but the grouping,
   * and it never reaches a provider. See `WirePart` in `@repo/core`.
   */
  turn: z.string().optional(),
  /**
   * The pictures this call's result carried, by URI, in the order the wire
   * put them after the result.
   *
   * A tool that reads a picture hands the model the file itself, and the wire
   * carries those bytes as a `user` turn after the `tool` message rather than
   * inside it. Keeping the URIs — not the bytes, which stay on disk where
   * they were — is what lets a replay put that turn back. Absent for every
   * call that showed nothing, and for a block saved before it was kept.
   */
  images: z
    .array(z.object({ uri: z.string(), mimeType: z.string() }))
    .optional(),
});
export type ToolState = z.infer<typeof toolState>;

/** Arguments of a `read` call, of which only the path is interesting. */
const readArgs = z.object({ path: z.string() });

/**
 * The file a successful `read` was pointed at, if that is what this block
 * records. The output is bytes either way, so the path's extension is the
 * only thing that says how to render them.
 */
function readPath(state: ToolState): string | null {
  if (state.name !== "read" || !state.ok) return null;
  let args: unknown;
  try {
    args = JSON.parse(state.args);
  } catch {
    return null;
  }
  const parsed = readArgs.safeParse(args);
  return parsed.success ? parsed.data.path : null;
}

/** Grammar to highlight a tool's `output` with. A successful `edit` call's
 *  output is always a unified diff, whatever file it touched, so it is
 *  always highlighted as one; a `read` call's output is the target file's
 *  own language, by extension. Every other tool renders as plain text. */
export function toolLanguage(state: ToolState): string | null {
  if (state.name === "edit" && state.ok) return "diff";
  const path = readPath(state);
  return path ? languageForPath(path) : null;
}

export const toolKind = defineKind({
  kind: TOOL_KIND,
  schema: toolState,
  snapshot: (state) => {
    const call = `tool ${state.name}(${state.args}) ->`;
    // A failed call is labelled as such, so an agent reading this back does
    // not mistake an error message for what the tool found.
    return state.ok
      ? `${call}\n${state.output}`
      : `${call} error:\n${state.output}`;
  },
  // The call as the provider saw it: an assistant message's `tool_calls`
  // entry, answered by a `tool` message. `args` travels as the string it
  // already is — it was captured from the wire, and re-encoding an object
  // would not guarantee the same bytes, which is what a cache matches on.
  // The result is `output` alone, without the `ok` marker or the call line:
  // the wire's tool message is what the tool printed, and a failure is
  // already inside that text.
  wire: (state) => ({
    wire: "toolCall",
    name: state.name,
    args: state.args,
    result: state.output,
    ...(state.turn === undefined ? {} : { turn: state.turn }),
    ...(state.images?.length
      ? { images: state.images.map((image): ContextImage => image) }
      : {}),
  }),
  defaults: { name: "", args: "", output: "", ok: true },
});
