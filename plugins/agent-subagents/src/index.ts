import { definePlugin } from "@repo/plugins";
import { spawnSubagentTool } from "./tools/spawn-subagent/index.ts";

/**
 * Agent subagents: handing a self-contained task to another agent run. Ships
 * the `spawn_subagent` tool, which runs a nested agent on a context the
 * caller supplies and returns its answer, with the subagent's whole
 * transcript nested under the call's own block. The subagent inherits the
 * spawning run's inference configuration and environment, so spawning may
 * recurse; its `agent` argument can instead name any Weaver agent the system
 * prompt lists, letting a run hand a task to an agent whose instructions and
 * tools suit it better than the caller's own.
 */
export const agentSubagents = definePlugin({
  id: "agent-subagents",
  name: "Agent subagents",
  description: "Hand a self-contained task to a nested agent run.",
  tools: [spawnSubagentTool],
});

export default agentSubagents;

export * from "./tools/spawn-subagent/index.ts";
