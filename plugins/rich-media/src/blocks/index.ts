/**
 * Aggregate of the plugin's block kinds under the standard `blocks/`
 * directory shape. Importing the plugin's `src/index.ts` registers these
 * into the graph's kind registry; individual kinds, schemas and helpers are
 * re-exported from their own subdirectories for renderers and the harness.
 */
export * from "./media/index.ts";
export * from "./tool/index.ts";
export * from "./user/index.ts";