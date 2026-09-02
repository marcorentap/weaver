import { Fragment } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { common, createLowlight } from "lowlight";
import { cn } from "@/lib/utils";

/**
 * highlight.js' common language set: about forty grammars, which is every
 * language a block is likely to hold and small enough to highlight
 * synchronously while a row renders. Module-level, because the registry is
 * built once and read on every render.
 */
const lowlight = createLowlight(common);

/**
 * File extension to grammar. A read tool's output is just bytes, so the path
 * it was called with is the only thing that says how to colour them; an
 * extension that is not here renders as plain text rather than being guessed
 * at, because a wrong guess colours a log file like Perl.
 */
const LANGUAGES: Record<string, string> = {
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

/**
 * Code, highlighted into `hljs-*` spans that globals.css colours. An unknown
 * or unregistered grammar still renders — as the plain text it came in as.
 */
export function CodeBlock({
  code,
  language,
  className,
}: {
  code: string;
  language: string | null;
  className?: string;
}) {
  const classes = cn("min-w-0 overflow-x-auto whitespace-pre", className);
  if (!language || !lowlight.registered(language)) {
    return <pre className={classes}>{code}</pre>;
  }
  return (
    <pre className={classes}>
      {toJsxRuntime(lowlight.highlight(language, code), {
        Fragment,
        jsx,
        jsxs,
      })}
    </pre>
  );
}
