import { ipcMain } from "electron";
import type { AgentSummary } from "../../shared/ipc-contract.js";
import { listAgents } from "../lib/agents.js";
import { weaverRoot } from "../lib/project.js";

/**
 * Serve the agent shelves to the renderer. Discovery is filesystem work over
 * `~/.weaver/agents` and `<project>/.weaver/agents`, which only main can do,
 * and it is the same `listAgents` the `@agents:` completion and the run
 * engine use, so the dialog's menu cannot offer an agent a run would not
 * resolve.
 *
 * `pwd` roots the project shelf at the block's own merged `WEAVER_PWD`,
 * exactly like `@file:` and `@skill:` completion, so a message written under
 * one environment lists that project's agents.
 */
export function registerAgentListHandlers(): void {
  ipcMain.handle("agents:list", (_, pwd?: string): AgentSummary[] =>
    listAgents(weaverRoot(pwd)),
  );
}
