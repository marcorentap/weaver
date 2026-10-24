import { join } from "node:path";
import { app } from "electron";
import type { PluginTool } from "@repo/plugins";
import {
  listAgents,
  resolveAgent,
  type AgentSummary,
  type WeaverAgent,
} from "@plugins/weaver-agents";
import type { BuildResult } from "esbuild";

export { listAgents, resolveAgent };
export type { AgentSummary, WeaverAgent };

/**
 * The shape an agent's tool file exports, as far as this loader cares: the
 * same SDK-agnostic `PluginTool` this repo's plugins ship, so a tool written
 * for an agent and a tool written for a plugin differ in where they are
 * mounted, not in how they are written. A file may export one tool as its
 * default, or an array (a `tools` named export works too) for a small family
 * of related calls kept together.
 */
function isPluginTool(value: unknown): value is PluginTool {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.label === "string" &&
    (typeof candidate.description === "string" ||
      Array.isArray(candidate.description) ||
      // A description computed at mount time (see `PluginTool.description`)
      // is the same shape as any other to this loader: the harness calls it
      // with the run's scope when the tool is mounted.
      typeof candidate.description === "function") &&
    typeof candidate.execute === "function" &&
    typeof candidate.parameters === "object" &&
    candidate.parameters !== null
  );
}

/** The tools one tool module exports, in the order a run should mount them. */
function moduleTools(mod: unknown): PluginTool[] {
  const exported = mod as { default?: unknown; tools?: unknown };
  const value = exported.default ?? exported.tools;
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.filter(isPluginTool);
}

/**
 * Bundle one agent tool file and import it.
 *
 * Bundled rather than imported raw for the same reason a drop-in plugin is
 * (`main/lib/plugins.ts`): the file is TypeScript, may import `@repo/*`
 * packages, and lives in a directory with no `node_modules` of its own.
 * esbuild resolves everything from the app's own dependencies and hands back
 * one module, which is then imported through a data URL. A tool that fails
 * to load is reported and skipped — one broken file must not make an agent
 * unrunnable, though the model should know the tool it was told about is
 * missing, so the warning says which agent and which file.
 */
async function importToolModule(
  entry: string,
  agent: WeaverAgent,
  moduleRoots: string[],
): Promise<PluginTool[]> {
  try {
    const esbuild = await import("esbuild");
    const built = (await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "esnext",
      nodePaths: moduleRoots,
      write: false,
    })) as BuildResult;
    const code = built.outputFiles?.[0]?.text;
    if (!code) return [];
    const mod = await import(
      "data:text/javascript," + encodeURIComponent(code)
    );
    return moduleTools(mod);
  } catch (error) {
    console.warn(
      `agent "${agent.name}" tool ${entry} failed to load:`,
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

/**
 * Every tool the agent at `agent` ships, mounted alongside the harness's and
 * the plugins' own. Loading is per run rather than per process because the
 * agent is chosen per run, and an agent's tools are only ever offered to a
 * run invoked as that agent.
 *
 * A duplicated name keeps the first tool and warns: two files that both
 * claim `search` are an authoring mistake, and silently mounting one over
 * the other would make which one ran depend on file order.
 */
export async function loadAgentTools(
  agent: WeaverAgent,
): Promise<PluginTool[]> {
  if (agent.toolFiles.length === 0) return [];
  const moduleRoots = [join(app.getAppPath(), "node_modules")];
  const tools: PluginTool[] = [];
  const claimed = new Set<string>();
  for (const entry of agent.toolFiles) {
    for (const tool of await importToolModule(entry, agent, moduleRoots)) {
      if (claimed.has(tool.name)) {
        console.warn(
          `agent "${agent.name}" ships two tools named "${tool.name}"; keeping the first`,
        );
        continue;
      }
      claimed.add(tool.name);
      tools.push(tool);
    }
  }
  return tools;
}
