import { loadSkills } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "../../../shared/fuzzy.js";
import type { LinkOption } from "../../../shared/ipc-contract.js";
import { AGENT_DIR, resourceDirs } from "../agent-dir.js";
import type { LinkProvider } from "./types.js";

/**
 * Rescanning every skills directory on each keystroke is filesystem work
 * for a list that only changes when a `SKILL.md` is added, so a scan is
 * reused for a short window. Mirrors the file provider's cache: fresh
 * enough that a new skill appears without a restart.
 */
const CACHE_TTL_MS = 5_000;

type SkillSummary = {
  name: string;
  description: string;
  filePath: string;
};

type Cache = { root: string; at: number; skills: SkillSummary[] };

let cache: Cache | null = null;

function skillsFor(root: string): SkillSummary[] {
  if (cache && cache.root === root && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.skills;
  }
  // The same directories a run loads from, named explicitly: `~/.agents/
  // skills` and `<root>/.agents/skills`. pi's own discovery is not used —
  // with `includeDefaults: true` it would also scan pi's project-local
  // `.pi/skills`, which weaver never reads. A malformed SKILL.md yields
  // diagnostics, not a thrown error, so a bad file is simply absent from
  // the list.
  const { skills } = loadSkills({
    cwd: root,
    agentDir: AGENT_DIR,
    skillPaths: resourceDirs("skills", root),
    includeDefaults: false,
  });
  const summaries = skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
  }));
  cache = { root, at: Date.now(), skills: summaries };
  return summaries;
}

/**
 * The `SKILL.md` a `@skill:<name>` points at, or null when no discovered
 * skill carries that name. It uses the same directories a run loads from, so
 * a reference resolves to the skill the model would have loaded, not a
 * same-named one from somewhere the app never reads.
 */
export function skillFileFor(name: string, root: string): string | null {
  const skill = skillsFor(root).find((candidate) => candidate.name === name);
  return skill?.filePath ?? null;
}

export const skillProvider: LinkProvider = {
  id: "skill",
  label: "skill",
  description: "An agent skill the run can load.",
  async search(query, { root, limit }): Promise<LinkOption[]> {
    const skills = skillsFor(root);
    return fuzzyFilter(
      query,
      skills,
      (skill) => `${skill.name} ${skill.description}`,
      limit,
    ).map((skill) => ({
      value: skill.name,
      label: skill.name,
      detail: skill.description || skill.filePath,
    }));
  },
};
