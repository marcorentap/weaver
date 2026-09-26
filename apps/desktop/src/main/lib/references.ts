import { readFile } from "node:fs/promises";
import type { ContextMessage } from "@repo/core";
import { parseReferences, type Reference } from "../../shared/references.js";
import { formatReadResult, readSource } from "./read-source.js";
import { skillFileFor } from "./links/skill.js";

/**
 * The extra context a message's `@<type>:<value>` references become: one
 * `developer` message per distinct reference, in the order the message
 * attached them. A person who writes `@file:src/app.ts` or `@skill:unslop`
 * is pointing the run at that thing and expecting it to be consulted, so the
 * material travels with the turn instead of the model reading the token as
 * prose and spending a tool call to chase it — and instead of the token
 * meaning nothing when the run has no tools at all.
 *
 * Reads are attached the way the `read` tool attaches them: a file becomes
 * the same truncated, tree-sitter-indexed view a whole-file read produces
 * (see `readSource` and `formatReadResult`), not its entire bytes. A skill,
 * by contrast, is meant in full — its `SKILL.md` is a short procedure, not a
 * source file — so it is read whole. The reference itself is written above
 * the content so the model can see which token the material answers.
 *
 * `cwd` is the run's own working directory, so `@file:` resolves against the
 * same root a `read` in this run would, and `@skill:` against the same
 * discovery directories. A reference that cannot be resolved — a missing
 * file, a skill nobody defines, a type this resolver does not know — is
 * simply left out: the token stays in the user's message, and the model can
 * still follow it with its tools.
 */
export async function referenceMessages(
  texts: readonly string[],
  cwd: string,
): Promise<ContextMessage[]> {
  const seen = new Set<string>();
  const messages: ContextMessage[] = [];
  for (const text of texts) {
    for (const reference of parseReferences(text)) {
      const key = `${reference.type}:${reference.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const content = await resolveReference(reference, cwd);
      if (content !== null) messages.push({ role: "developer", content });
    }
  }
  return messages;
}

/** The material one reference points at, or null when it points at nothing
 *  this resolver can read. */
async function resolveReference(
  reference: Reference,
  cwd: string,
): Promise<string | null> {
  if (reference.type === "file") {
    try {
      const result = await readSource(reference.value, cwd);
      return `@file:${reference.value}\n\n${formatReadResult(result)}`;
    } catch {
      return null;
    }
  }
  if (reference.type === "skill") {
    const file = skillFileFor(reference.value, cwd);
    if (!file) return null;
    try {
      const content = await readFile(file, "utf8");
      return `@skill:${reference.value}\n\n${content}`;
    } catch {
      return null;
    }
  }
  return null;
}
