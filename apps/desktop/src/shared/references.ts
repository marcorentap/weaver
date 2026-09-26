/**
 * One `@<type>:<value>` reference written inline in a message, the same
 * token `LinkInput` completes: the type after the `@`, the value after the
 * `:`. It is the renderer's promise that it deliberately pointed the run at
 * something, so the run attaches that thing itself instead of leaving the
 * model to read the token as prose.
 */
export type Reference = {
  /** The token after `@`, e.g. "file" or "skill". */
  type: string;
  /** What comes after the `:`, e.g. "./src/app.ts" or "unslop". */
  value: string;
};

/**
 * An `@`-reference: it starts at a word boundary — line start or whitespace,
 * the same rule that keeps an email address from opening the completion
 * menu — the type is a short identifier, and the value runs to the next
 * whitespace, mirroring how `LinkInput` writes one.
 */
const REFERENCE = /(?:^|\s)@([A-Za-z0-9_-]+):(\S+)/g;

/**
 * Punctuation a reference can pick up from the sentence around it — a path
 * at the end of a clause (`see @file:src/a.ts.`) or a value in parentheses
 * — and that is not part of what it names. Trailing path characters like
 * `/` or `-` are left alone, since they can be real.
 */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/**
 * The distinct references `text` attaches, in the order they appear. One
 * occurrence of a reference is enough: attaching `@file:src/a.ts` twice says
 * the same thing, and the run should carry that file once. Unknown types are
 * returned too — whether a type can be resolved is the resolver's business,
 * not the parser's — so a caller can tell "the user attached a reference"
 * from "the user wrote an `@`".
 */
export function parseReferences(text: string): Reference[] {
  const found: Reference[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(REFERENCE)) {
    const type = match[1] ?? "";
    const value = (match[2] ?? "").replace(TRAILING_PUNCTUATION, "");
    if (!type || !value) continue;
    const key = `${type}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ type, value });
  }
  return found;
}
