import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import { config as reactConfig } from "@repo/eslint-config/react-internal";
import { config as baseConfig } from "@repo/eslint-config/base";

const eslintConfig = defineConfig([
  // Renderer: browser-only, same rules apps/web used for its client tree.
  {
    files: ["src/renderer/**/*.{ts,tsx}", "src/shared/**/*.ts"],
    extends: reactConfig,
  },
  // Main/preload: Node-only, no React/browser rules — this is the process
  // that owns the SQLite store, spawns processes and reads/writes disk.
  {
    files: ["src/main/**/*.ts", "src/preload/**/*.ts"],
    extends: baseConfig,
    languageOptions: {
      globals: globals.node,
    },
  },
  globalIgnores(["out/**", "dist/**", "resources/**"]),
]);

export default eslintConfig;
