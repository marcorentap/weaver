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

/**
 * The directory name a project keeps its *weaver-specific* agent resources
 * in. It takes the same shape as `.agents` — `skills/`, `prompts/`,
 * `themes/`, `extensions/`, `APPEND_SYSTEM.md` — and sits above it: a
 * project that wants to redefine one of the skills it inherits from
 * `.agents` or `~/.agents` does so here, without editing a directory it may
 * not own, and without the redefinition being shadowed by the copy it
 * replaces. Everything else in `.agents` still loads.
 */
export const WEAVER_DIR_NAME = ".weaver";

/** `<cwd>/.agents`: the project half of the convention. */
export function projectAgentsDir(cwd: string): string {
  return join(cwd, AGENTS_DIR_NAME);
}

/** `<cwd>/.weaver`: the project's override of `<cwd>/.agents`. */
export function projectWeaverDir(cwd: string): string {
  return join(cwd, WEAVER_DIR_NAME);
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
 * Every directory a resource kind comes from, most specific first.
 *
 * The order is the precedence, because pi keeps the *first* entry it loads
 * under a given name: skills, prompt templates and themes are each keyed by
 * name, and a later directory's copy of a name already seen is dropped as a
 * collision. So a project's `.weaver/<kind>` overrides its `.agents/<kind>`,
 * which overrides the user's `~/.agents/<kind>`, and an entry only a less
 * specific directory has still loads.
 *
 * Shared by a run's resource loader and the `@skill:` link provider, so the
 * menu lists exactly the skills a run would load.
 */
export function resourceDirs(type: AgentResourceType, cwd: string): string[] {
  return [
    join(projectWeaverDir(cwd), type),
    join(projectAgentsDir(cwd), type),
    join(AGENT_DIR, type),
  ];
}
