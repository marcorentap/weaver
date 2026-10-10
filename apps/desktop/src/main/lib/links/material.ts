import { readFile } from "node:fs/promises";
import type { LinkMaterial } from "../../../shared/ipc-contract.js";
import { parseReferences, type Reference } from "../../../shared/references.js";
import { formatReadResult, readSource } from "../read-source.js";
import { skillFileFor } from "./skill.js";

/**
 * What a message's `@<type>:<value>` references point at, one entry per
 * distinct reference, in the order the message attached them. A person who
 * writes `@file:src/app.ts` or `@skill:unslop` is pointing the run at that
 * thing and expecting it to be consulted, so the material is materialized
 * into the graph — as a block right above the message — instead of the model
 * reading the token as prose and spending a tool call to chase it, and
 * instead of the token meaning nothing when the run has no tools at all.
 * Living in the graph rather than in one run's payload is what makes it
 * durable: it is read like any other block, by that message's run and by
 * every run after it, and it can be edited, moved or deleted like one.
 *
 * Files are attached the way the `read` tool attaches them: the same
 * truncated, tree-sitter-indexed view a whole-file read produces (see
 * `readSource` and `formatReadResult`), not the entire bytes. A skill, by
 * contrast, is meant in full — its `SKILL.md` is a short procedure, not a
 * source file — so it is read whole.
 *
 * `root` is the project the message's own merged `WEAVER_PWD` points at, so
 * `@file:` resolves against the same base a run anchored there would read
 * from, and `@skill:` against the same discovery directories. A reference
 * that cannot be resolved — a missing file, a skill nobody defines, a type
 * this resolver does not know — is simply left out: the token stays in the
 * user's message, and the model can still follow it with its tools.
 */
export async function linkMaterials(
  text: string,
  root: string,
): Promise<LinkMaterial[]> {
  const materials: LinkMaterial[] = [];
  for (const reference of parseReferences(text)) {
    const material = await resolveReference(reference, root);
    if (material) materials.push(material);
  }
  return materials;
}

/** The material one reference points at, or null when it points at nothing
 *  this resolver can read. */
async function resolveReference(
  reference: Reference,
  root: string,
): Promise<LinkMaterial | null> {
  if (reference.type === "file") {
    try {
      const result = await readSource(reference.value, root);
      return {
        label: `@file:${reference.value}`,
        text: formatReadResult(result),
      };
    } catch {
      return null;
    }
  }
  if (reference.type === "skill") {
    const file = skillFileFor(reference.value, root);
    if (!file) return null;
    try {
      return {
        label: `@skill:${reference.value}`,
        text: await readFile(file, "utf8"),
      };
    } catch {
      return null;
    }
  }
  return null;
}
