import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A Weaver agent is a directory, not a single file: the description a person
 * picks it by, the instructions a run is given when it is picked, the tools
 * that run may call, and the skills it loads. Keeping each of those in its
 * own file is what lets an agent be edited piecemeal — a skill copied in, one
 * tool rewritten — without anything ever reassembling a manifest.
 *
 * Agents live in two places, the same two tiers every other agent resource
 * has. `~/.weaver/agents/<name>/` is the user's own shelf and
 * `<project>/.weaver/agents/<name>/` is the project's, and the two are
 * *merged* rather than one replacing the other: an agent only the user has is
 * still offered inside the project, and a project agent of the same name is
 * the one that wins. `.weaver` — not `.agents` — because an agent is weaver's
 * own construct: it binds pi's tools and skills to weaver's run, which no
 * other harness would know what to do with, exactly as plugins and the store
 * already live under `.weaver`.
 */
export const DESCRIPTION_FILE = "DESCRIPTION.md";
export const INSTRUCTION_FILE = "INSTRUCTION.md";

/** The directory name both tiers keep their agents in. */
const AGENTS_DIR_NAME = "agents";

/** `~/.weaver/agents`: the user's shelf, available to every project. */
export function globalAgentsDir(): string {
  return join(homedir(), ".weaver", AGENTS_DIR_NAME);
}

/** `<root>/.weaver/agents`: the project's own shelf. */
export function projectAgentsDir(root: string): string {
  return join(root, ".weaver", AGENTS_DIR_NAME);
}

/**
 * Every directory agents are discovered from, most specific first. The order
 * is the precedence: the first directory that holds a name owns it, so a
 * project's agent shadows the user's copy of the same name and every other
 * agent — from either tier — is still there.
 */
export function agentSearchDirs(root: string): string[] {
  return [projectAgentsDir(root), globalAgentsDir()];
}

/** Which tier an agent came from, so a list can say whether running the
 *  project's copy or the user's own. */
export type AgentSource = "project" | "global";

/** What a menu needs: a name to pick and a line to recognize it by. */
export type AgentSummary = {
  /** The directory name, which is also the `@agents:` value. */
  name: string;
  /** `DESCRIPTION.md`, trimmed; empty when the file is missing or blank. */
  description: string;
  source: AgentSource;
};

/** A complete agent, as a run mounts it. */
export type WeaverAgent = AgentSummary & {
  /** The agent's own directory. */
  dir: string;
  /** `INSTRUCTION.md`, trimmed; empty when the agent has none. */
  instructions: string;
  /** Directories handed to the run's skill loader, most specific first. */
  skillDirs: string[];
  /** TypeScript entry points under `tools/`, in a stable order. The app
   *  bundles each one and mounts the tool it exports. */
  toolFiles: string[];
};

/**
 * Rescanning both shelves on every keystroke is filesystem work for a list
 * that only changes when a directory appears, so a scan is reused for a
 * short window. Same rhythm as the `@skill:` provider's cache: fresh enough
 * that a new agent shows up without a restart.
 */
const CACHE_TTL_MS = 5_000;

type Cache = { at: number; agents: AgentSummary[] };

const caches = new Map<string, Cache>();

/** A directory entry an agent could be: a plain directory, not a hidden or
 *  private one. Underscored names are the shelf's own scratch space. */
function isAgentDirName(name: string): boolean {
  return !name.startsWith(".") && !name.startsWith("_");
}

/** The DESCRIPTION.md an agent is picked by, read whole and trimmed. A
 *  missing or unreadable file is an undocumented agent, not a broken one. */
export function readDescription(dir: string): string {
  try {
    return readFileSync(join(dir, DESCRIPTION_FILE), "utf8").trim();
  } catch {
    return "";
  }
}

/** The INSTRUCTION.md a run is given. Missing is the same as empty: the
 *  agent then only contributes its tools and skills. */
export function readInstructions(dir: string): string {
  try {
    return readFileSync(join(dir, INSTRUCTION_FILE), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Every tool entry point an agent ships. A tool is either a file — rewritten
 * in place, the way a one-off tool usually is — or a directory with an
 * index, mirroring how this repository's own plugin tools are laid out, so
 * the same shape works in both places.
 */
export function listAgentToolFiles(dir: string): string[] {
  const toolsDir = join(dir, "tools");
  let entries;
  try {
    entries = readdirSync(toolsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(toolsDir, entry.name);
    if (entry.isFile() && /\.(ts|js|mjs)$/.test(entry.name)) {
      files.push(full);
    } else if (entry.isDirectory()) {
      for (const index of ["index.ts", "index.js", "index.mjs"]) {
        const candidate = join(full, index);
        if (existsSync(candidate)) {
          files.push(candidate);
          break;
        }
      }
    }
  }
  return files.sort();
}

/** The skill directories an agent ships, as the loader wants them: the
 *  parent `skills/` directory, whose subdirectories each hold a `SKILL.md`. */
function agentSkillDirs(dir: string): string[] {
  const skillsDir = join(dir, "skills");
  return existsSync(skillsDir) ? [skillsDir] : [];
}

/**
 * Every agent the project can run, merged across both shelves with the
 * project's copy winning a shared name. Sorted by name so the completion
 * menu and the inference dialog read the same way regardless of the order
 * the filesystem happened to hand directories back.
 */
export function listAgents(root: string): AgentSummary[] {
  const cached = caches.get(root);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.agents;

  const agents: AgentSummary[] = [];
  const claimed = new Set<string>();
  for (const [tier, dir] of agentSearchDirs(root).entries()) {
    const source: AgentSource = tier === 0 ? "project" : "global";
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isAgentDirName(entry.name)) continue;
      // `claimed` is what makes the merge a merge: a project agent shadows
      // the global one of the same name without hiding any other agent.
      if (claimed.has(entry.name)) continue;
      claimed.add(entry.name);
      const agentDir = join(dir, entry.name);
      agents.push({
        name: entry.name,
        description: readDescription(agentDir),
        source,
      });
    }
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  caches.set(root, { at: Date.now(), agents });
  return agents;
}

/** A name that cannot escape the shelf: agent names are directory names, and
 *  a reference value is user-written text that must never become a path
 *  traversal. The pattern alone would still let `.` and `..` through, and a
 *  dot-name is a hidden directory the list never offers, so both are refused
 *  here as well as by the scan. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The agent called `name`, with everything a run mounts, or null when no
 * shelf holds it. Resolved from the project's shelf first for the same
 * reason `listAgents` merges in that order: the project's copy is the one
 * that wins.
 */
export function resolveAgent(name: string, root: string): WeaverAgent | null {
  if (!SAFE_NAME.test(name)) return null;
  for (const [tier, shelf] of agentSearchDirs(root).entries()) {
    const dir = join(shelf, name);
    if (!isDirectory(dir)) continue;
    return {
      name,
      description: readDescription(dir),
      source: tier === 0 ? "project" : "global",
      dir,
      instructions: readInstructions(dir),
      skillDirs: agentSkillDirs(dir),
      toolFiles: listAgentToolFiles(dir),
    };
  }
  return null;
}
