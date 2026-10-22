/**
 * `remark-math` reads `$…$` as inline math, and money is written the same way.
 * `$5 and $10` pairs the two dollar signs and hands `5 and ` to KaTeX, so a
 * price comes out set as a formula. micromark does refuse a delimiter whose
 * content ends in whitespace in some positions, but not reliably enough to
 * save a sentence: "range $10-$20" is math to it as well.
 *
 * A dollar immediately followed by a digit is an amount, not a delimiter, so
 * it is backslash-escaped here — which makes it a literal `$` to the
 * tokenizer and keeps it out of any math pairing. The cost is inline math
 * whose body starts with a digit (`$5^n$`), which is rarer in a chat message
 * than a price is; `$$…$$` is left alone, since no price is written that way
 * and display math is the unambiguous case worth keeping whole.
 *
 * This runs on the source rather than on the parsed tree because it has to
 * land before `remark-math` sees the text, so the scan is by hand. It only
 * needs to know where code is: a `$` inside a fence or a span is literal
 * already, and a backslash there is literal too, so both are copied through
 * untouched.
 */

/** A fence opening: up to three spaces of indent, then three or more of ``` or ~~~. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** An autolink, the only `<…>` where a backslash stays literal. */
const AUTOLINK = /^<[A-Za-z][A-Za-z0-9+.-]*:[^\s<>]*>/;

function countRun(text: string, from: number, char: string): number {
  let end = from;
  while (text[end] === char) end++;
  return end - from;
}

/** Index of the next backtick run of exactly `length`, or -1. */
function findClosingRun(text: string, from: number, length: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    const run = countRun(text, i, "`");
    if (run === length) return i;
    i += run;
  }
  return -1;
}

/** Escape the currency dollars on one line, leaving code spans verbatim. */
function escapeLine(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const char = line[i]!;
    // CommonMark lets a backslash escape any ASCII punctuation, so a `\$`
    // already in the source is a literal dollar and its `$` must not be
    // considered again here.
    if (char === "\\") {
      out += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === "`") {
      const run = countRun(line, i, "`");
      const close = findClosingRun(line, i + run, run);
      if (close === -1) {
        // An unmatched run is ordinary text, so scanning carries on past it.
        out += line.slice(i, i + run);
        i += run;
        continue;
      }
      const end = close + run;
      out += line.slice(i, end);
      i = end;
      continue;
    }
    if (char === "<") {
      // An autolink keeps a backslash as a literal character, so escaping a
      // `$` in `<http://host/$5>` would put one in the URL. Only a real
      // autolink is skipped: a bare `<` in "cheaper than < $5" must not eat
      // the price after it.
      const autolink = AUTOLINK.exec(line.slice(i));
      if (autolink) {
        out += autolink[0];
        i += autolink[0].length;
        continue;
      }
    }
    if (char === "$") {
      const run = countRun(line, i, "$");
      // A run of two or more opens display math; copied whole so `$$5+5$$`
      // keeps parsing as math instead of the second `$` being escaped.
      const end = i + run;
      out +=
        run > 1 ? line.slice(i, end) : isDigit(line[end] ?? "") ? "\\$" : "$";
      i = end;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

/**
 * The markdown source with currency amounts escaped, ready for
 * `remark-math`. Fences are tracked line by line; a code span that runs
 * across a line break is the one case the scan treats as ordinary text,
 * which is rare enough not to be worth a real block parser here.
 */
export function escapeCurrencyDollars(source: string): string {
  const lines = source.split("\n");
  let fence: { char: string; length: number } | null = null;
  const out: string[] = [];
  for (const line of lines) {
    if (fence) {
      out.push(line);
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (
        close &&
        close[1]![0] === fence.char &&
        close[1]!.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      out.push(line);
      continue;
    }
    out.push(escapeLine(line));
  }
  return out.join("\n");
}
