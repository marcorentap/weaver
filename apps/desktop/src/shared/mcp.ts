import { z } from "zod";

/**
 * One MCP server a run mounts, as it travels from the renderer to the main
 * process.
 *
 * The settings page keeps a server's fields the way it keeps every other
 * setting — as text a person types — so a command line is one string and a
 * server's headers are the lines they were written as. This is the other
 * end: the shape the main process connects from, already split, because the
 * SDK wants an executable and an argv rather than something a shell would
 * have to parse, and a transport's own fields rather than both alike.
 */
export const mcpServer = z.object({
  /** The name the server's tools are offered under, and what a failure
   *  names. The settings key, so it is unique within a run. */
  name: z.string().min(1),
  transport: z.enum(["stdio", "http"]),
  /** A local server's command line, e.g. `npx -y @modelcontextprotocol/
   *  server-filesystem /tmp`. Split by `splitCommandLine`, never by a
   *  shell: this app invokes it directly so nothing in a user's config can
   *  turn into shell syntax by accident. Required for `stdio`. */
  command: z.string().optional(),
  /** A remote server's endpoint, for the streamable HTTP transport.
   *  Required for `http`. */
  url: z.string().optional(),
  /** Extra headers a remote server needs, e.g. an authorization token. */
  headers: z.record(z.string(), z.string()).optional(),
});

export type McpServer = z.infer<typeof mcpServer>;

/**
 * Splits a command line into an argv the way a shell would for the common
 * cases: whitespace separates words, and single or double quotes group them.
 * A backslash inside double quotes escapes the next character, which is what
 * makes a quoted JSON argument (`-e '{"a":1}'`) expressible.
 *
 * Deliberately not a shell: no expansion, no globbing, no `;` — an MCP
 * server's command comes from a settings field, and running it through a
 * shell would make a typo a way to run a second command.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote === '"') {
      if (char === "\\" && i + 1 < line.length) {
        word += line[++i];
      } else if (char === '"') {
        quote = null;
      } else {
        word += char;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += char;
    started = true;
  }
  if (started) words.push(word);
  return words;
}

/**
 * Reads the `Name: value` lines a remote server's headers are typed as.
 * Blank lines are skipped, a line without a colon is kept with an empty
 * value rather than dropped, and the first colon separates name from value
 * (`Authorization: Bearer a:b` keeps its second colon).
 */
export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(":");
    if (at === -1) {
      headers[trimmed] = "";
      continue;
    }
    headers[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return headers;
}
