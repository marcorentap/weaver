import { fuzzyFilter } from "../../../shared/fuzzy.js";
import type { AgentSummary, LinkOption } from "../../../shared/ipc-contract.js";
import { AGENTS_LINK_TYPE } from "../../../shared/references.js";
import { listAgents } from "../agents.js";
import type { LinkProvider } from "./types.js";

/**
 * What a shelf is called in a menu line, for an agent with no
 * `DESCRIPTION.md` to say it better. Bundled agents ship a description, so
 * the label is what a user's or project's unfinished agent falls back to.
 */
const SOURCE_LABEL: Record<AgentSummary["source"], string> = {
  project: "project agent",
  global: "global agent",
  bundled: "bundled agent",
};

/**
 * The `@agents:` link: a message naming one of the weaver agents on any
 * shelf. Writing it does two things — the agent's description is written
 * into the graph above the message like any other link material, and the run
 * anchored on the message is invoked as that agent — so this provider only
 * has to offer the names. Both halves read the same `listAgents` the run
 * engine resolves against, so the menu cannot offer an agent a run would not
 * find.
 */
export const agentProvider: LinkProvider = {
  id: AGENTS_LINK_TYPE,
  label: "agents",
  description:
    "A weaver agent, whose instructions, tools and skills this run uses.",
  async search(query, { root, limit }): Promise<LinkOption[]> {
    return fuzzyFilter(
      query,
      listAgents(root),
      (agent) => `${agent.name} ${agent.description}`,
      limit,
    ).map((agent) => ({
      value: agent.name,
      label: agent.name,
      detail: agent.description || SOURCE_LABEL[agent.source],
    }));
  },
};
