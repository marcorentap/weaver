import { createPatch } from "diff";
import { readWhole, resolveFileTarget, targetLabel, writeWhole } from "./file-target.js";

export type EditReplacement = {
  /** Exact text to replace. Must be unique in the file and must not overlap
   *  any other edit's `oldText` in the same call. */
  oldText: string;
  newText: string;
};

export type EditSourceResult = {
  /** Unified diff between the file's previous and new content. Empty
   *  `oldText === newText` edits still round-trip through this — the diff
   *  just has no hunks. */
  diff: string;
};

/**
 * Applies `edits` to `original`, all matched against the original text (not
 * incrementally against each other's result) — same contract as the SDK's
 * own `edit` tool this replaces. Throws if an `oldText` is missing, appears
 * more than once, or overlaps another edit's range.
 */
function applyEdits(original: string, edits: EditReplacement[]): string {
  if (edits.length === 0) {
    throw new Error("edits must contain at least one replacement");
  }

  const ranges = edits.map((edit, index) => {
    if (edit.oldText === "") {
      throw new Error(`edits[${index}].oldText must not be empty`);
    }
    const first = original.indexOf(edit.oldText);
    if (first === -1) {
      throw new Error(
        `edits[${index}].oldText not found in file: ${JSON.stringify(edit.oldText.slice(0, 120))}`,
      );
    }
    if (original.indexOf(edit.oldText, first + 1) !== -1) {
      throw new Error(
        `edits[${index}].oldText matches more than once — make it unique: ${JSON.stringify(edit.oldText.slice(0, 120))}`,
      );
    }
    return {
      index,
      start: first,
      end: first + edit.oldText.length,
      newText: edit.newText,
    };
  });

  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && current.start < previous.end) {
      throw new Error(
        `edits[${current.index}] overlaps edits[${previous.index}] — merge them into one edit`,
      );
    }
  }

  let result = "";
  let cursor = 0;
  for (const range of sorted) {
    result += original.slice(cursor, range.start) + range.newText;
    cursor = range.end;
  }
  return result + original.slice(cursor);
}

/**
 * Applies `edits` to the file at `target` — a bare filesystem path, a
 * `file://` URI, or an `ssh://[user@]host[:port]/path` URI — and returns a
 * unified diff of the change. `cwd` anchors a bare relative path.
 */
export async function editSource(
  target: string,
  cwd: string,
  edits: EditReplacement[],
): Promise<EditSourceResult> {
  const resolved = resolveFileTarget(target, cwd);
  const original = await readWhole(resolved);
  const updated = applyEdits(original, edits);
  const label = targetLabel(resolved);
  const diff = createPatch(label, original, updated);
  await writeWhole(resolved, updated);
  return { diff };
}
