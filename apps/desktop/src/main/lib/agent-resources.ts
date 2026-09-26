import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_DIR,
  projectAgentsDir,
  projectWeaverDir,
  resourceDirs,
  type AgentResourceType,
} from "./agent-dir.js";

/**
 * Which of pi's four discoverable resource kinds a run wants. An enabled
 * kind is supplied from the three agent directories — `~/.agents/<kind>`,
 * `<cwd>/.agents/<kind>` and `<cwd>/.weaver/<kind>`; a disabled one
 * contributes nothing at all.
 */
export type AgentResources = Record<AgentResourceType, boolean>;

/**
 * The settings a run reads. Only the agent directory's own
 * `~/.agents/settings.json` is live: `projectTrusted: false` is what keeps
 * pi from opening `<cwd>/.pi/settings.json`, which it would otherwise treat
 * as this project's settings.
 *
 * Untrusted is the accurate description, not a workaround. pi's project
 * settings are a pi-CLI feature — they can point at packages to install and
 * resources to enable — and weaver takes none of its agent configuration
 * from pi. Everything a project contributes is handed to the loader
 * explicitly instead (`createAgentResourceLoader`), so there is nothing left
 * for a project settings file to say.
 */
export function createAgentSettings(cwd: string): SettingsManager {
  return SettingsManager.create(cwd, AGENT_DIR, { projectTrusted: false });
}

/**
 * Append-prompt files weaver honors: `~/.agents/APPEND_SYSTEM.md`, then the
 * project's append prompt — `<cwd>/.weaver/APPEND_SYSTEM.md` when the project
 * has one, `<cwd>/.agents/APPEND_SYSTEM.md` otherwise. Existing files only.
 *
 * The two project directories are one tier, not two sources: an append prompt
 * is a single document, so a project keeping its own under `.weaver` is
 * replacing the one it inherited rather than appending a second. The user's
 * file is a different tier and still applies.
 *
 * Handing the list over — even when it is empty — is what stops pi from
 * discovering `<cwd>/.pi/APPEND_SYSTEM.md` for itself. An entry that does not
 * exist is not merely skipped: pi treats a missing source as literal prompt
 * text, so it must be filtered here.
 */
function appendSystemPromptSources(cwd: string): string[] {
  const project = [projectWeaverDir(cwd), projectAgentsDir(cwd)]
    .map((dir) => join(dir, "APPEND_SYSTEM.md"))
    .find((path) => existsSync(path));
  return [join(AGENT_DIR, "APPEND_SYSTEM.md"), project].filter(
    (path): path is string => path !== undefined && existsSync(path),
  );
}

/**
 * Extension entry points inside a directory.
 *
 * Skills, prompts and themes all take a directory and scan it themselves; pi's
 * extension loader takes *files*, one per extension. The scan that turns a
 * folder into those files lives in pi's package manager
 * (`collectAutoExtensionEntries`), which weaver deliberately does not use, so
 * it is reproduced here, narrowly:
 *
 * - a directory that names its own entries — `package.json`'s `pi.extensions`,
 *   or an `index.ts`/`index.js` — is a single extension;
 * - otherwise its `.ts`/`.js` files are extensions;
 * - and a subdirectory is one only if it names an index, so a package dropped
 *   into the directory loads, but an arbitrary source tree does not.
 *
 * Not reproduced: pi's `.gitignore` handling. Weaver's extension directory is
 * a handful of hand-placed entries, not a checkout.
 */
function extensionEntries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const declared = declaredExtensionEntries(dir);
  if (declared) return declared;

  const entries: string[] = [];
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const child of children) {
    if (child.name.startsWith(".") || child.name === "node_modules") continue;
    const full = join(dir, child.name);
    if (child.isFile() && /\.(ts|js)$/.test(child.name)) {
      entries.push(full);
    } else if (child.isDirectory()) {
      entries.push(...(declaredExtensionEntries(full) ?? []));
    }
  }
  return entries;
}

/** The entries an extension directory declares for itself, or null when it
 *  declares none and is therefore a container rather than an extension. */
function declaredExtensionEntries(dir: string): string[] | null {
  const manifest = join(dir, "package.json");
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        pi?: { extensions?: unknown };
      };
      const declared = parsed.pi?.extensions;
      if (Array.isArray(declared)) {
        const files = declared
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => join(dir, entry))
          .filter((file) => existsSync(file));
        if (files.length > 0) return files;
      }
    } catch {
      // An unreadable manifest declares nothing; fall through to the index
      // files, and let pi report the extension itself if it is one.
    }
  }
  for (const index of ["index.ts", "index.js"]) {
    const file = join(dir, index);
    if (existsSync(file)) return [file];
  }
  return null;
}

/**
 * Every extension file a run loads, most specific directory first.
 *
 * Skills, prompt templates and themes are keyed by name, and pi keeps the
 * first entry it loads under a name it has already seen, so a less specific
 * directory's copy loses on its own. An extension has no such key: pi
 * registers every file it is handed, so the same extension present in two
 * directories would load twice and register its tools twice. The key used
 * here is therefore the entry's path inside its own `extensions/` directory —
 * `<cwd>/.weaver/extensions/foo.ts` replaces `<cwd>/.agents/extensions/foo.ts`,
 * and a differently named extension, or one only the user has, still loads.
 */
function extensionPaths(cwd: string): string[] {
  const claimed = new Set<string>();
  const paths: string[] = [];
  for (const dir of resourceDirs("extensions", cwd)) {
    for (const file of extensionEntries(dir)) {
      const key = relative(dir, file);
      if (claimed.has(key)) continue;
      claimed.add(key);
      paths.push(file);
    }
  }
  return paths;
}

/**
 * The resource loader a run uses. Everything about discovery is stated here
 * rather than left to pi:
 *
 * pi discovers resources from its own directories — the agent dir it is
 * given *and* a project-local `.pi/`, whose name is compiled into the
 * package and cannot be changed from the outside. So all four built-in
 * discovery passes are switched off and each wanted directory is passed as
 * an explicit path instead. That leaves exactly three sources, all ours:
 * `~/.agents/<kind>`, `<cwd>/.agents/<kind>` and `<cwd>/.weaver/<kind>`,
 * and no path by which `<cwd>/.pi` could be read.
 *
 * The cost is pi's package manager: resources installed from an npm/git
 * source declared in a settings file are no longer resolved. Weaver has no
 * way to declare one (it exposes no such setting, and it reads no project
 * settings file), so nothing regresses — there was never a package to
 * resolve.
 *
 * `noContextFiles` is the caller's, and is the one thing still left to pi's
 * own machinery: project context files are `AGENTS.md`, an Agent Skills
 * convention read from the working directory and its ancestors, not from
 * `.pi`.
 */
export function createAgentResourceLoader(options: {
  cwd: string;
  settingsManager: SettingsManager;
  /** The whole system prompt. pi's own is replaced wholesale rather than
   *  appended to (its CLI-agent phrasing and SDK-built tool list are not
   *  what a weaver block is); tools still reach the model through the SDK's
   *  own tool array, so nothing about the tool list is lost. Handing a
   *  source over explicitly is also what keeps pi from looking for
   *  `<cwd>/.pi/SYSTEM.md` by itself. */
  systemPrompt: string;
  resources: AgentResources;
  noContextFiles: boolean;
}): DefaultResourceLoader {
  const { cwd, settingsManager, systemPrompt, resources, noContextFiles } =
    options;
  // Existing directories only. Naming one that is not there earns a
  // "path does not exist" diagnostic from pi against a directory the user
  // never claimed to have, and nothing is created on the user's behalf.
  const dirs = (type: AgentResourceType): string[] =>
    resources[type]
      ? resourceDirs(type, cwd).filter((dir) => existsSync(dir))
      : [];

  return new DefaultResourceLoader({
    cwd,
    agentDir: AGENT_DIR,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles,
    additionalExtensionPaths: resources.extensions ? extensionPaths(cwd) : [],
    additionalSkillPaths: dirs("skills"),
    additionalPromptTemplatePaths: dirs("prompts"),
    additionalThemePaths: dirs("themes"),
    appendSystemPrompt: appendSystemPromptSources(cwd),
    systemPrompt,
  });
}
