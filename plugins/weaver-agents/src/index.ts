import { definePlugin } from "@repo/plugins";

/**
 * Weaver agents: named instruction-and-tool bundles a run can be invoked as.
 *
 * An agent is a directory — `DESCRIPTION.md` to pick it by, `INSTRUCTION.md`
 * to steer the run with, `tools/` for its TypeScript tools and `skills/` for
 * the `SKILL.md` files it loads. The user keeps theirs in
 * `~/.weaver/agents/<name>/`, a project keeps its own in
 * `<project>/.weaver/agents/<name>/`, and the app merges the two shelves, the
 * project's copy winning a name it shares.
 *
 * Nothing about an agent is a block kind or a tool in the plugin contract's
 * sense: an agent changes *how* a run is configured (its system prompt, its
 * tool list, its skill paths), which the plugin contract does not carry.
 * The app therefore reads the shelves itself — through `listAgents` and
 * `resolveAgent` below, the same way `rich-media` exposes `attachableImage`
 * for the `read` tool — and this plugin is the registration point that says
 * the agent system is present, plus the one place its directory convention
 * is stated. The `@agents:` link provider, the run engine and the custom
 * inference dialog all import from this package, so the convention cannot
 * drift between them.
 */
export const weaverAgents = definePlugin({
  id: "weaver-agents",
  name: "Weaver agents",
  description:
    "Named instruction-and-tool bundles a run can be invoked as, from ~/.weaver/agents and .weaver/agents.",
});

export default weaverAgents;

export * from "./agents.ts";
