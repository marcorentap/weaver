import { z } from "zod";
import type { ContextMessage } from "@repo/core";
import { defineKind } from "@repo/core";

/**
 * A multiple-choice question the agent raised and the user answers in place,
 * as a block rather than as a pause in the run. The answer lives in the
 * block's own state, so a later run that reads the graph — or that is
 * anchored on this block and re-run — sees the question and the answer both
 * as context.
 *
 * The same block is also what a run raised *during* a turn stops on: a tool
 * that needs an answer it cannot guess hands the question here and waits,
 * and the submission below is what starts the run again, in the same run,
 * with the answer as the tool's result. See `multichoiceResume`.
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
  /**
   * Whether the person submitted this answer, which is not the same thing as
   * having picked options: a run stopped on this block resumes on the
   * submission, so a multi-select question is answered once rather than once
   * per checkbox, and a pick made while thinking it over is not yet an
   * answer to anything.
   *
   * Defaulted rather than required because blocks written before this field
   * existed are still in sessions: they read as never submitted, which is
   * what makes them continue to behave exactly as they did — the answer they
   * hold is theirs to show, and only a run parked on one asks for the flag.
   */
  answered: z.boolean().default(false),
});
export type MultichoiceState = z.infer<typeof multichoiceState>;

/**
 * The user's answer to the question, as the bullets it reads as: the picked
 * options in `options` order, the Other text when Other was picked, and the
 * note. Empty while the question is unanswered — the state holds a question
 * whether or not anyone has answered it, which is what makes an unanswered
 * one tellable apart from an answered one.
 */
export function multichoiceAnswer(state: MultichoiceState): string {
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
  return bullets.map((bullet) => `- ${bullet}`).join("\n");
}

/**
 * What a run stopped on this block resumes with: the submitted answer as the
 * same bullets the block reads as, or null while it has not been submitted.
 *
 * The submission flag, not the picked options, is what releases the run: the
 * block is answered when the person says it is. An answer nothing was picked
 * into still says so in words, because a run has to come back with something
 * it can act on — "I picked nothing and left no note" is information, and an
 * empty string would leave the model to guess whether anyone had answered at
 * all.
 */
export function multichoiceResume(state: MultichoiceState): string | null {
  if (!state.answered) return null;
  return multichoiceAnswer(state) || "(nothing picked and no note)";
}

/**
 * How a multichoice block reads as a document: the question alone, then the
 * user's answer as a bullet list under a `user:` marker. Unanswered it is
 * just the question, exactly what the block holds before the user answered.
 *
 * The marker belongs here because nothing outside the text can say who is
 * speaking. In a conversation, something can: see `turns` below, where the
 * same block arrives as an assistant turn and a user turn instead.
 *
 * What reads as an answer here is the answer text, not `answered`: a block
 * written before submission existed holds an answer with no flag, and a
 * block someone has picked options into but not submitted holds choices with
 * no answer yet. The text is the one thing both agree on.
 */
export function multichoiceSnapshot(state: MultichoiceState): string {
  const prompt = state.prompt.trim();
  const answer = multichoiceAnswer(state);
  const lines = prompt ? [prompt] : [];
  if (answer) lines.push("user:", answer);
  return lines.join("\n");
}

/**
 * How a multichoice block reads as a conversation — the one block kind that
 * holds both sides of an exchange, and so the one that needs two turns where
 * every other kind needs one.
 *
 * The question is the assistant's, because a run is what asked it; the answer
 * is the person's, because picking the choices is what they did. Unanswered,
 * only the question is there, which is what the model that asked it should
 * find on re-reading: a question with nothing after it has not been answered.
 *
 * The `user:` marker `multichoiceSnapshot` writes has no place in these
 * turns. There the role says who is speaking, and an answer quoting itself
 * back would read as a person narrating their own reply.
 *
 * This holds wherever the block is read from: as context above a later run,
 * and as the block a run is anchored on, where the answer is what the model
 * is prompted with and the question is the turn it continues from.
 */
function multichoiceTurns(state: MultichoiceState): ContextMessage[] {
  const turns: ContextMessage[] = [];
  const prompt = state.prompt.trim();
  if (prompt) turns.push({ role: "assistant", content: prompt });
  const answer = multichoiceAnswer(state);
  if (answer) turns.push({ role: "user", content: answer });
  return turns;
}

export const multichoiceKind = defineKind({
  kind: MULTICHOICE_KIND,
  schema: multichoiceState,
  snapshot: multichoiceSnapshot,
  turns: multichoiceTurns,
  resume: multichoiceResume,
  defaults: {
    prompt: "",
    options: [],
    selected: [],
    other: "",
    note: "",
    answered: false,
  },
});
