/**
 * Tree-sitter symbol indexes for reads of whole code files.
 *
 * A whole-file read (no `offset`/`limit`/bytes) of a recognized code file
 * returns an index of its top-level symbols, functions, classes, types and
 * so on, each with a 1-indexed line number -- not the file's content. A
 * 2,000-line file used to be a 50k-token read; now it is a few hundred
 * tokens, and the model reads exactly the sections it needs with
 * `offset`/`limit` afterwards.
 *
 * The index is built from a tree-sitter parse of the full local file (local
 * IO, cheap) but rendered under `MAX_READ_BYTES`, so no index output ever
 * exceeds the read budget either.
 *
 * Grammars are prebuilt WASM. The runtime `web-tree-sitter` is pinned to
 * 0.24.7 in package.json on purpose: 0.25+ only loads dylink-format
 * grammars, which `tree-sitter-wasms` (built with an older CLI) does not
 * ship. Both wasm sets are copied next to the bundled main process by
 * electron.vite.config.ts; do not bump either dependency without re-testing
 * `Language.load` against the grammar files.
 */
import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import TreeSitter from "web-tree-sitter";

/** Budget for one read result, index output included. */
export const MAX_READ_BYTES = 4 * 1024;

/** Files larger than this are not indexed (parse time, memory): they get
 *  the bounded content read like any other file. */
const MAX_INDEX_FILE_BYTES = 2 * 1024 * 1024;
/** Per-parse wall-clock guard; a pathological file falls back to the
 *  bounded read instead of hanging the run. */
const MAX_PARSE_MICROS = 2_000_000;
/** Display cap on one symbol's text in the index. */
const SIGNATURE_CAP = 110;
/** Bounded parse cache: last `INDEX_CACHE_MAX` indexed files, keyed by
 *  path + size + mtime, so re-reading an unchanged file does not reparse. */
const INDEX_CACHE_MAX = 64;

/** WASM runtime core, copied next to the bundled main process under
 *  `wasm/`. Loaded once; `Parser.init` is Emscripten's module init and
 *  must run before any load. */
const CORE_WASM = "tree-sitter.wasm";

/** Directory (relative to the bundled main process) the build copies all
 *  wasm files into. See electron.vite.config.ts. */
const WASM_DIR = "wasm";

type LangSpec = {
  /** Display name used in the index header. */
  name: string;
  /** Grammar wasm file name, as copied next to `out/main/index.js`. */
  wasm: string;
  /** Grammar node type -> short label, for declarations worth listing. */
  kinds: Record<string, string>;
  /** Node types whose bodies hold nested declarations (class methods,
   *  impl blocks, namespaces). Descent stops one level deep. */
  containers: Record<string, true>;
};

/**
 * Node types below were verified against the actual grammars in
 * `tree-sitter-wasms@0.1.13` (a probe parsed a sample per language). A type
 * missing here is simply skipped by the walker, so grammar drift degrades
 * to a shorter index, never a crash. Languages without real symbols (json,
 * css, markup, config) are intentionally absent: reading them is a bounded
 * content read.
 */
const TS: Omit<LangSpec, "wasm"> = {
  name: "typescript",
  kinds: {
    function_declaration: "fn",
    class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    method_definition: "method",
    abstract_method_signature: "method",
    lexical_declaration: "var",
  },
  containers: { class_declaration: true },
};

const JS: Omit<LangSpec, "wasm"> = {
  name: "javascript",
  kinds: {
    function_declaration: "fn",
    class_declaration: "class",
    method_definition: "method",
    lexical_declaration: "var",
    variable_declaration: "var",
  },
  containers: { class_declaration: true },
};

const PY: Omit<LangSpec, "wasm"> = {
  name: "python",
  kinds: {
    function_definition: "fn",
    class_definition: "class",
  },
  containers: { class_definition: true },
};

const RS: Omit<LangSpec, "wasm"> = {
  name: "rust",
  kinds: {
    function_item: "fn",
    struct_item: "struct",
    enum_item: "enum",
    trait_item: "trait",
    impl_item: "impl",
    mod_item: "mod",
    type_item: "type",
    const_item: "const",
    static_item: "static",
    macro_definition: "macro",
  },
  containers: { impl_item: true, trait_item: true, mod_item: true },
};

const GO: Omit<LangSpec, "wasm"> = {
  name: "go",
  kinds: {
    function_declaration: "fn",
    method_declaration: "fn",
    type_declaration: "type",
    const_declaration: "const",
    var_declaration: "var",
  },
  containers: {},
};

const JAVA: Omit<LangSpec, "wasm"> = {
  name: "java",
  kinds: {
    class_declaration: "class",
    interface_declaration: "interface",
    enum_declaration: "enum",
    record_declaration: "record",
    annotation_type_declaration: "annotation",
    method_declaration: "fn",
    constructor_declaration: "ctor",
  },
  containers: {
    class_declaration: true,
    interface_declaration: true,
    enum_declaration: true,
    record_declaration: true,
  },
};

const C: Omit<LangSpec, "wasm"> = {
  name: "c",
  kinds: {
    function_definition: "fn",
    struct_specifier: "struct",
    enum_specifier: "enum",
    union_specifier: "union",
    type_definition: "typedef",
  },
  containers: {},
};

const CPP: Omit<LangSpec, "wasm"> = {
  name: "c++",
  kinds: {
    function_definition: "fn",
    class_specifier: "class",
    struct_specifier: "struct",
    enum_specifier: "enum",
    union_specifier: "union",
    type_definition: "typedef",
    alias_declaration: "alias",
    namespace_definition: "namespace",
  },
  containers: { class_specifier: true, struct_specifier: true, namespace_definition: true },
};

const CS: Omit<LangSpec, "wasm"> = {
  name: "c#",
  kinds: {
    namespace_declaration: "namespace",
    class_declaration: "class",
    interface_declaration: "interface",
    enum_declaration: "enum",
    struct_declaration: "struct",
    record_declaration: "record",
    method_declaration: "fn",
    constructor_declaration: "ctor",
    property_declaration: "prop",
  },
  containers: {
    namespace_declaration: true,
    class_declaration: true,
    interface_declaration: true,
    struct_declaration: true,
    record_declaration: true,
  },
};

const BASH: Omit<LangSpec, "wasm"> = {
  name: "bash",
  kinds: { function_definition: "fn" },
  containers: {},
};

const RUBY: Omit<LangSpec, "wasm"> = {
  name: "ruby",
  kinds: {
    class: "class",
    module: "module",
    method: "fn",
    singleton_method: "fn",
  },
  containers: { class: true, module: true },
};

const PHP: Omit<LangSpec, "wasm"> = {
  name: "php",
  kinds: {
    function_definition: "fn",
    class_declaration: "class",
    interface_declaration: "interface",
    trait_declaration: "trait",
    enum_declaration: "enum",
    method_declaration: "fn",
  },
  containers: {
    class_declaration: true,
    interface_declaration: true,
    trait_declaration: true,
    enum_declaration: true,
  },
};

const SWIFT: Omit<LangSpec, "wasm"> = {
  name: "swift",
  // This grammar reports structs, enums and extensions all as
  // `class_declaration`; the signature line distinguishes them.
  kinds: {
    function_declaration: "fn",
    class_declaration: "type",
    protocol_declaration: "protocol",
    typealias_declaration: "type",
  },
  containers: { class_declaration: true },
};

const KOTLIN: Omit<LangSpec, "wasm"> = {
  name: "kotlin",
  // This grammar exposes no `name` field on declarations; entries fall
  // back to the signature line.
  kinds: {
    function_declaration: "fn",
    class_declaration: "class",
    object_declaration: "object",
    interface_declaration: "interface",
  },
  containers: { class_declaration: true, object_declaration: true, interface_declaration: true },
};

const SCALA: Omit<LangSpec, "wasm"> = {
  name: "scala",
  kinds: {
    function_definition: "fn",
    class_definition: "class",
    trait_definition: "trait",
    object_definition: "object",
    type_definition: "type",
  },
  containers: { class_definition: true, object_definition: true, trait_definition: true },
};

const LUA: Omit<LangSpec, "wasm"> = {
  name: "lua",
  kinds: { function_definition_statement: "fn" },
  containers: {},
};

/** Extension -> language spec. Extensions absent here get a bounded read. */
const SPECS: Record<string, LangSpec> = {
  ".ts": { wasm: "tree-sitter-typescript.wasm", ...TS },
  ".mts": { wasm: "tree-sitter-typescript.wasm", ...TS },
  ".cts": { wasm: "tree-sitter-typescript.wasm", ...TS },
  ".tsx": { wasm: "tree-sitter-tsx.wasm", ...TS },
  ".js": { wasm: "tree-sitter-javascript.wasm", ...JS },
  ".jsx": { wasm: "tree-sitter-javascript.wasm", ...JS },
  ".mjs": { wasm: "tree-sitter-javascript.wasm", ...JS },
  ".cjs": { wasm: "tree-sitter-javascript.wasm", ...JS },
  ".py": { wasm: "tree-sitter-python.wasm", ...PY },
  ".rs": { wasm: "tree-sitter-rust.wasm", ...RS },
  ".go": { wasm: "tree-sitter-go.wasm", ...GO },
  ".java": { wasm: "tree-sitter-java.wasm", ...JAVA },
  ".c": { wasm: "tree-sitter-c.wasm", ...C },
  ".h": { wasm: "tree-sitter-c.wasm", ...C },
  ".cpp": { wasm: "tree-sitter-cpp.wasm", ...CPP },
  ".cc": { wasm: "tree-sitter-cpp.wasm", ...CPP },
  ".cxx": { wasm: "tree-sitter-cpp.wasm", ...CPP },
  ".hpp": { wasm: "tree-sitter-cpp.wasm", ...CPP },
  ".hh": { wasm: "tree-sitter-cpp.wasm", ...CPP },
  ".hxx": { wasm: "tree-sitter-cpp.wasm", ...CPP },
  ".cs": { wasm: "tree-sitter-c_sharp.wasm", ...CS },
  ".sh": { wasm: "tree-sitter-bash.wasm", ...BASH },
  ".bash": { wasm: "tree-sitter-bash.wasm", ...BASH },
  ".rb": { wasm: "tree-sitter-ruby.wasm", ...RUBY },
  ".php": { wasm: "tree-sitter-php.wasm", ...PHP },
  ".swift": { wasm: "tree-sitter-swift.wasm", ...SWIFT },
  ".kt": { wasm: "tree-sitter-kotlin.wasm", ...KOTLIN },
  ".kts": { wasm: "tree-sitter-kotlin.wasm", ...KOTLIN },
  ".scala": { wasm: "tree-sitter-scala.wasm", ...SCALA },
  ".sc": { wasm: "tree-sitter-scala.wasm", ...SCALA },
  ".lua": { wasm: "tree-sitter-lua.wasm", ...LUA },
};

/** WASM files the build copies next to the bundled main process. */
export const WASM_ASSETS = [
  CORE_WASM,
  ...[...new Set(Object.values(SPECS).map((spec) => spec.wasm))].sort(),
];

type Entry = {
  line: number;
  label: string;
  text: string;
};

/**
 * A declaration node type (e.g. `export_statement`, `decorated_definition`)
 * that wraps the real declaration as its last named child. In TS, exports
 * wrap in `export_statement`; in Python, decorated definitions wrap in
 * `decorated_definition` with decorators before the definition. A bare
 * `export { a, b }` unwraps to an `export_clause`, which is not a kind, so
 * it is simply skipped.
 */
function unwrap(node: TreeSitter.SyntaxNode): TreeSitter.SyntaxNode {
  let current = node;
  while (current.type === "export_statement" || current.type === "decorated_definition") {
    const children = current.namedChildren;
    const last = children[children.length - 1];
    if (!last) break;
    current = last;
  }
  return current;
}

/** A declaration's name: its `name` field, or one found on a direct child
 *  (go's `type_declaration` carries its name on the nested `type_spec`,
 *  TS's `lexical_declaration` on the `variable_declarator`). */
function nameOf(node: TreeSitter.SyntaxNode): string | null {
  const named = node.childForFieldName("name");
  if (named && named.text.length > 0) return named.text;
  for (const child of node.namedChildren) {
    const nested = child.childForFieldName("name");
    if (nested && nested.text.length > 0) return nested.text;
  }
  return null;
}

/** One index line's text: the clean name when the grammar exposes one,
 *  otherwise the declaration's first line cut at the body opener. */
function entryText(node: TreeSitter.SyntaxNode, fallbackLabel: string | null): string {
  const name = nameOf(node);
  if (name) {
    return fallbackLabel === "var" || fallbackLabel === "const" || fallbackLabel === "let"
      ? `${fallbackLabel} ${name}`
      : name;
  }
  const firstLine = (node.text.split("\n", 1)[0] ?? "").trim();
  let text = firstLine.replace(/\s+$/g, "");
  const cut = text.search(/\s(?:[={]|=>)\s*/);
  if (cut > 0) text = text.slice(0, cut);
  text = text.replace(/[;:{]\s*$/, "").trim();
  if (text.length > SIGNATURE_CAP) text = `${text.slice(0, SIGNATURE_CAP - 1)}…`;
  return text;
}

function entry(node: TreeSitter.SyntaxNode, label: string): Entry {
  // `const` / `let` / `var`: the grammar's kind field, when present, is a
  // better label than the generic map value.
  const kindText = node.childForFieldName("kind")?.text;
  const resolved = kindText && kindText.length > 0 ? kindText : label;
  return {
    line: node.startPosition.row + 1,
    label: resolved,
    text: entryText(node, resolved),
  };
}

/** Top-level declarations plus one level into container bodies. */
function collectEntries(root: TreeSitter.SyntaxNode, spec: LangSpec): Entry[] {
  const entries: Entry[] = [];
  for (const top of root.namedChildren) {
    const node = unwrap(top);
    const label = spec.kinds[node.type];
    if (label) entries.push(entry(node, label));
    if (spec.containers[node.type]) {
      for (const body of node.namedChildren) {
        for (const member of body.namedChildren) {
          const nested = unwrap(member);
          const nestedLabel = spec.kinds[nested.type];
          if (nestedLabel) entries.push(entry(nested, nestedLabel));
        }
      }
    }
  }
  return entries;
}

function countLines(source: string): number {
  let lines = 0;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lines++;
  }
  return source.length > 0 && source.charCodeAt(source.length - 1) !== 10 ? lines + 1 : lines;
}

function render(entries: Entry[], totalLines: number, spec: LangSpec): string {
  const header = `[symbol index · ${spec.name} · ${totalLines} lines · ${entries.length} symbols]`;
  const lines = entries.map(
    (e) => `${String(e.line).padStart(5)}  ${e.label.padEnd(11)} ${e.text}`,
  );
  const footer = `\n[… ${entries.length - lines.length} more symbols]`;

  // Fit everything under the read budget. The footer reserves its own
  // space, so a truncated index still says how much was dropped.
  const body: string[] = [];
  let bytes = Buffer.byteLength(`${header}\n`);
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(`${line}\n`);
    if (bytes + lineBytes + Buffer.byteLength(footer) > MAX_READ_BYTES) break;
    body.push(line);
    bytes += lineBytes;
  }
  const dropped = lines.length - body.length;
  const tail = dropped > 0 ? footer : "";
  return `${header}\n${body.join("\n")}${body.length > 0 ? "\n" : ""}${tail}`;
}

let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  const started = TreeSitter.init({
    wasmBinary: readFileSync(join(import.meta.dirname, WASM_DIR, CORE_WASM)),
  }).catch((error: unknown) => {
    initPromise = null;
    throw error;
  });
  initPromise = started;
  return started;
}

const languageCache = new Map<string, TreeSitter.Language>();
const parserCache = new Map<string, TreeSitter>();
const indexCache = new Map<string, { content: string; totalLines: number }>();

async function languageFor(spec: LangSpec): Promise<TreeSitter.Language | null> {
  const cached = languageCache.get(spec.wasm);
  if (cached) return cached;
  await ensureInit();
  try {
    const language = await TreeSitter.Language.load(
      readFileSync(join(import.meta.dirname, WASM_DIR, spec.wasm)),
    );
    languageCache.set(spec.wasm, language);
    return language;
  } catch (error) {
    console.error(`symbol index: failed to load ${spec.wasm}:`, error);
    return null;
  }
}

function parserFor(spec: LangSpec, language: TreeSitter.Language): TreeSitter {
  const cached = parserCache.get(spec.wasm);
  if (cached) return cached;
  const parser = new TreeSitter();
  parser.setTimeoutMicros(MAX_PARSE_MICROS);
  parser.setLanguage(language);
  parserCache.set(spec.wasm, parser);
  return parser;
}

export type SymbolIndex = {
  content: string;
  totalLines: number;
};

/**
 * Build a symbol index for a local file, or null when the file is not
 * indexable (unknown language, too large, unreadable). Never throws: a
 * failure is a signal for the caller's bounded read path.
 */
export async function buildSymbolIndex(path: string): Promise<SymbolIndex | null> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_INDEX_FILE_BYTES) return null;
  const spec = SPECS[extname(path).toLowerCase()];
  if (!spec) return null;

  const key = `${path}\0${stat.size}:${stat.mtimeMs}`;
  const cached = indexCache.get(key);
  if (cached) return cached;

  const language = await languageFor(spec);
  if (!language) return null;
  const source = readFileSync(path, "utf8");
  const tree = parserFor(spec, language).parse(source);
  if (!tree) return null;
  try {
    const entries = collectEntries(tree.rootNode, spec);
    if (entries.length === 0) return null;
    const result = { content: render(entries, countLines(source), spec), totalLines: countLines(source) };
    if (indexCache.size >= INDEX_CACHE_MAX) {
      const oldest = indexCache.keys().next().value;
      if (oldest !== undefined) indexCache.delete(oldest);
    }
    indexCache.set(key, result);
    return result;
  } finally {
    tree.delete();
  }
}