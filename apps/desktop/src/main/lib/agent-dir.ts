import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Weaver's agent directory: the one place its agent resources are discovered
 * from, and the base pi's own bookkeeping (`auth.json`, `models.json`,
 * `settings.json`) hangs off.
 *
 * It is `~/.agents` — the Agent Skills convention — and deliberately not
 * pi's `~/.pi/agent`. Weaver embeds pi as a library but presents itself as
 * its own harness, so it must never read or write the pi CLI's home. The
 * `@skill:` link provider and every inference run share this constant, so
 * both discover exactly the same skills.
 */
export const AGENT_DIR = join(homedir(), ".agents");

/**
 * Steer pi's implicit defaults at `AGENT_DIR` for the whole process.
 *
 * pi resolves its default agent directory — the one used for auth, settings,
 * sessions and resource discovery whenever a caller does not pass an
 * explicit `agentDir` — from `PI_CODING_AGENT_DIR`, falling back to
 * `~/.pi/agent`. Weaver does pass `agentDir` everywhere the SDK lets it, but
 * a path that forgets to (a `ModelRuntime` created without an explicit
 * credential store, say) would otherwise read and write `~/.pi`. Setting the
 * variable once, at import time and before any SDK call can run, makes every
 * path agree on `~/.agents`. An explicit `PI_CODING_AGENT_DIR` already in the
 * environment still wins.
 */
process.env.PI_CODING_AGENT_DIR ??= AGENT_DIR;

/**
 * The directory name a *project* keeps its agent resources in, mirroring the
 * user's `~/.agents`. pi's own project-local directory is `CONFIG_DIR_NAME`
 * (`".pi"`), compiled into the bundled package; it is fixed from the
 * outside, which is why weaver hands pi every directory explicitly rather
 * than relying on discovery (see `agent-resources.ts`).
 */
export const AGENTS_DIR_NAME = ".agents";

/** `<cwd>/.agents`: the project half of the convention. */
export function projectAgentsDir(cwd: string): string {
  return join(cwd, AGENTS_DIR_NAME);
}

/** The resource kinds pi can discover, and the four weaver supplies itself.
 *  A directory of the same name under `~/.agents` or `<cwd>/.agents` holds
 *  that kind: `skills/`, `prompts/`, `themes/`, `extensions/`. */
export const AGENT_RESOURCE_TYPES = [
  "skills",
  "prompts",
  "themes",
  "extensions",
] as const;

export type AgentResourceType = (typeof AGENT_RESOURCE_TYPES)[number];

/**
 * Every directory a resource kind comes from, user before project so the
 * project's more specific entries are read last and win collisions. Shared
 * by a run's resource loader and the `@skill:` link provider, so the menu
 * lists exactly the skills a run would load.
 */
export function resourceDirs(type: AgentResourceType, cwd: string): string[] {
  return [join(AGENT_DIR, type), join(projectAgentsDir(cwd), type)];
}
