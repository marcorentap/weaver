import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import babel from "vite-plugin-babel";
import { viteStaticCopy } from "vite-plugin-static-copy";
import tailwindcss from "@tailwindcss/postcss";
import { WASM_ASSETS } from "./src/main/lib/symbol-index";

const reactCompilerConfig = {
  target: "19",
};

export default defineConfig({
  main: {
    plugins: [
      // `@repo/*` and `@plugins/*` ship raw `.ts` source (no build step of
      // their own; see the monorepo's "no-build" convention), so they
      // must be bundled/transpiled here rather than externalized like a
      // normal `node_modules` package. Node cannot `require()` a `.ts` file
      // directly, unlike Next/Turbopack, which transpiles them in one pass.
      externalizeDepsPlugin({
        exclude: [
          "@repo/core",
          "@repo/plugins",
          "@repo/store",
          "@plugins/agent-hindsight",
          "@plugins/agent-seerxng",
          "@plugins/agent-subagents",
          "@plugins/rich-media",
          "@plugins/user-input",
          "@plugins/weaver-agents",
        ],
      }),
      // `agent/system-prompt.md` is read at run time via `readFileSync`, not
      // imported as a module. It is copied next to the bundled `index.js` so
      // `__dirname`-relative reads keep working whether this is `electron-vite
      // dev`'s out-of-source build or a packaged app.
      viteStaticCopy({
        // electron-vite's main build runs as Vite's SSR build environment
        // (named "ssr", not the default "client"). Without this the
        // plugin's build hook never fires and nothing is copied.
        environment: "ssr",
        targets: [
          {
            src: resolve("src/main/agent/system-prompt.md"),
            dest: "agent",
            rename: { stripBase: true },
          },
          // The skills the app itself teaches — currently how to write a
          // weaver agent. Discovered by `BUNDLED_SKILLS_DIR` in
          // `main/lib/agent-dir.ts`, so they land beside the bundled main
          // process the way the system prompt does, and are the least
          // specific source of skills a run loads.
          {
            src: resolve("src/main/agent/skills/**/*"),
            dest: "skills",
            // The copy target reproduces the source path under `dest`, so
            // climbing out of `src/main/agent/skills` leaves exactly
            // `skills/<skill>/SKILL.md`. Four segments is that prefix; the
            // same trick the system-prompt copy above uses with `true`.
            rename: { stripBase: 4 },
          },
          // The agents the app ships — a shelf a person can shadow by
          // writing one of their own with the same name. Discovered by
          // `BUNDLED_AGENTS_DIR` in `main/lib/agent-dir.ts`, so they land as
          // `agents/<agent>/…` beside the bundled main process. Same
          // `stripBase` arithmetic as the skills copy above.
          // `src/main/agent/agents` is the shelf, so it flattens to `<agent>/…`.
          {
            src: resolve("src/main/agent/agents/**/*"),
            dest: "agents",
            rename: { stripBase: 4 },
          },
          // Symbol indexing (src/main/lib/symbol-index.ts) loads these at
          // run time with `readFileSync(import.meta.dirname/wasm, ...)`, so
          // they must land next to the bundled `out/main/index.js` under a
          // stable directory. The runtime wasm is
          // `web-tree-sitter/tree-sitter.wasm`, the rest are the
          // per-language grammars from `tree-sitter-wasms/out`.
          {
            src: resolve("node_modules/web-tree-sitter/tree-sitter.wasm"),
            dest: "wasm",
            rename: { stripBase: true },
          },
          ...WASM_ASSETS.filter((wasm) => wasm !== "tree-sitter.wasm").map(
            (wasm) => ({
              src: resolve("node_modules/tree-sitter-wasms/out", wasm),
              dest: "wasm",
              rename: { stripBase: true },
            }),
          ),
        ],
      }),
    ],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve("src/main/index.ts") },
        output: { format: "es" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        output: { format: "es" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    css: {
      postcss: {
        plugins: [tailwindcss()],
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve("src/renderer/index.html") },
      },
    },
    plugins: [
      // Rows re-render on every cursor move; the compiler's memoization is
      // what keeps that from re-parsing every block's state and every
      // markdown file (ported from apps/web's `reactCompiler: true`, which
      // has no Vite-native equivalent).
      babel({
        include: /\.[jt]sx?$/,
        babelConfig: {
          presets: ["@babel/preset-typescript"],
          plugins: [["babel-plugin-react-compiler", reactCompilerConfig]],
        },
      }),
      react(),
      // katex.min.css addresses its font files with bare relative
      // `url(fonts/...)`, which CSS Next's own pipeline resolves for free.
      // Vite leaves an unresolved `url()` untouched, so the actual font
      // files need to land next to the built CSS by hand.
      viteStaticCopy({
        targets: [
          {
            src: resolve("node_modules/katex/dist/fonts/*"),
            dest: "assets/fonts",
            rename: { stripBase: true },
          },
        ],
      }),
    ],
  },
});
