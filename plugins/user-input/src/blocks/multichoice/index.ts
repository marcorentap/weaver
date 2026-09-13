import { z } from "zod";
import { defineKind } from "@repo/core";

/**
 * A multiple-choice question the agent raised and the user answers in place,
 * as a block rather than as a pause in the run. The answer lives in the
 * block's own state, so a later run that reads the graph — or that is
 * anchored on this block and re-run — sees the question and the answer both
 * as context.
 */
export const MULTICHOICE_KIND = "multichoice";

/**
 * The choice that is always offered, whatever `options` holds. Kept outside
 * `options` so nothing can delete it; its text is what the user picks into,
 * and what snapshots carry as the marker of "Other was picked".
 */
export const OTHER_OPTION = "Other";

export const multichoiceState = z.object({
  /** The question asked of the user. */
  prompt: z.string(),
  /** The suggested choices, in display order. `OTHER_OPTION` is implied and
   *  never duplicated here. */
  options: z.array(z.string()),
  /** The choices the user picked, by their text. Multi-select. The literal
   *  `OTHER_OPTION` appears here when the user picked it, with the concrete
   *  wording for it in `other`. */
  selected: z.array(z.string()),
  /** What "Other" means to this user, blank until they picked it. */
  other: z.string(),
  /** The user's additional note, free text attached to the answer. */
  note: z.string(),
});
export type MultichoiceState = z.infer<typeof multichoiceState>;

/**
 * How a multichoice block reads as context: the question alone, then the
 * user's answer as a bullet list under a `user:` marker — the picked
 * options, the Other text when Other was picked, and the note. Unanswered
 * it is just the question, exactly what an agent should see before the user
 * answered; the reader never has to count checkboxes.
 */
export function multichoiceSnapshot(state: MultichoiceState): string {
  const prompt = state.prompt.trim();
  const bullets: string[] = [];
  for (const option of state.options) {
    if (state.selected.includes(option)) bullets.push(option);
  }
  if (state.selected.includes(OTHER_OPTION)) {
    bullets.push(
      state.other.trim() ? `Other: ${state.other.trim()}` : OTHER_OPTION,
    );
  }
  if (state.note.trim()) bullets.push(`Note: ${state.note.trim()}`);
  const lines = prompt ? [prompt] : [];
  if (bullets.length > 0) {
    lines.push("user:", ...bullets.map((bullet) => `- ${bullet}`));
  }
  return lines.join("\n");
}

export const multichoiceKind = defineKind({
  kind: MULTICHOICE_KIND,
  schema: multichoiceState,
  snapshot: multichoiceSnapshot,
  defaults: { prompt: "", options: [], selected: [], other: "", note: "" },
});
