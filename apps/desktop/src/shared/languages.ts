/**
 * File extension to grammar. Shared by `CodeBlock` (which highlighting to
 * apply) and the media kind (which extensions are plain text at all, as
 * opposed to something with no text viewer). An extension not listed here
 * has no known grammar; `CodeBlock` still renders it as plain preformatted
 * text rather than guessing, because a wrong guess colours a log file like
 * Perl.
 */
export const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  r: "r",
  diff: "diff",
  patch: "diff",
  graphql: "graphql",
  gql: "graphql",
  m: "objectivec",
  mm: "objectivec",
};

/** The grammar to highlight a file's contents with, or null for none. */
export function languageForPath(path: string): string | null {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  return LANGUAGES[name.slice(dot + 1)] ?? null;
}
