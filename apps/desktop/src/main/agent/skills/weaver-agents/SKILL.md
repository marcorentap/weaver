---
name: weaver-agents
description: Create, edit or debug a weaver agent. Use when asked to add an agent, change how one behaves, give it tools or skills, or explain where agents live and how they are invoked.
---

# Weaver agents

A weaver agent bundles four things a run can be invoked with: a description,
instructions, tools and skills. It is a directory, not a manifest, so each
part is edited on its own.

## Where agents live

Three shelves, merged:

- `~/.weaver/agents/<name>/` is the user's, available in every project.
- `<project>/.weaver/agents/<name>/` is the project's.
- The app ships one of its own — explorer, reviewer, archivist — beside the
  bundled main process. It is not a directory you edit: a fresh install's
  copy is inside the app, and an update replaces it.

The most specific shelf wins a shared name: the project's over the user's,
and the user's over a bundled agent. Every other agent from every shelf is
still offered. Do not duplicate an agent into the project to "make it
available" there; put it in `~/.weaver/agents` and it is already available.

To change a bundled agent, copy its directory into `~/.weaver/agents` under
the same name and edit the copy. That shadows it from then on, and the edit
survives an app update — which is why the shelf order is what it is.

`<project>` is the run's own working directory: its merged `WEAVER_PWD`, or
the app's project root when no environment block sets one.

## Layout

```
~/.weaver/agents/reviewer/
  DESCRIPTION.md      one or two sentences, shown in the pickers
  INSTRUCTION.md      how this agent works, appended to weaver's system prompt
  tools/
    check-links/
      index.ts        one tool, default-exported
  skills/
    release-notes/
      SKILL.md        ordinary agent skill, frontmatter and all
```

Every part is optional, but an agent with no `INSTRUCTION.md` and no tools
does nothing a plain run does not.

Bundled agents carry no `tools/`, only instructions and sometimes skills. An
agent's tool files are bundled with esbuild at run time, and esbuild cannot
open a path inside a packaged app's asar archive, so a tool that shipped with
the app would mount nothing in a release build while the model was still told
it existed. That constraint does not apply to your own agents: they live on
disk, outside the archive.

### DESCRIPTION.md

Plain prose, no frontmatter. It is the line the `@agents:` menu and the
custom inference dialog show, so write what the agent is for and when to pick
it. It is also what a message that attaches `@agents:<name>` writes into the
graph as the material block above the message.

### INSTRUCTION.md

The agent's operating instructions. They are appended to weaver's own system
prompt under a heading naming the agent, so do not repeat the harness rules
(what a block is, how a tool result reads) and do not restate weaver's general
behavior. Write the delta: the role, the procedure, the constraints, the
output shape.

Keep it about conduct, not about the repository, unless the agent is only
ever used in one repository.

### tools/

Each tool is a TypeScript file, or a directory with an `index.ts`. It should
default-export a `PluginTool`, the same shape this repo's plugins use: a name,
a label, a description, TypeBox parameters and an async `execute` that returns
`{ content, details }`. Export an array (or a named `tools` export) to ship
several tools from one file.

```ts
import { Type } from "typebox";
import type { PluginTool } from "@repo/plugins";

const tool: PluginTool = {
  name: "check_links",
  label: "Check links",
  description: [
    "Fetch every URL in a file and report the ones that no longer resolve.",
    "Pass a project-relative path. Slow on large files; one file per call.",
  ].join("\n"),
  parameters: Type.Object({
    path: Type.String({ description: "File whose links to check" }),
  }),
  async execute(args, ctx) {
    const path = String(args.path ?? "");
    // Work here. Throw to report a failure; the model sees the message.
    return { content: `checked ${path}`, details: {} };
  },
};

export default tool;
```

`description` may also be a function of the mount scope —
`(scope) => string | string[]` — for a tool whose options are whatever the
run can see. `scope.agents` lists the agents on the shelves with their
`DESCRIPTION.md`, so a tool that takes an agent name can say which names it
could take without hard-coding a list that goes stale; the harness calls the
function when it mounts the tool.

`execute` receives a `ToolRunContext`:

- `addBlock(kind, data, label)` lands a block right after the run's anchor.
  Optional. Fall back to text when it is missing.
- `wait(kind, data, label)` raises a block and parks the run until it is
  answered, returning the answer or null. Optional, and only for kinds whose
  own `resume` can answer it.
- `spawnAgent(messages, agent?)` runs a nested agent on the turns it is
  given and returns its final answer; `agent` names a Weaver agent to run it
  as, defaulting to the run's own. Optional.
- `getSetting(pluginId, key)` reads the app's plugin settings.
- `call` is the wire call's own `args` JSON string, for tools that materialize
  a block replaying their call.

Tool names are visible to the model alongside weaver's own tools, so give
them a verb-first name that does not collide with `read`, `write`, `edit`,
`grep`, `find`, `bash` or `display_media`.

A tool file is bundled with esbuild at run time, so a relative import of
another file in the agent directory works. A tool that fails to load is
skipped with a warning, not a failed run.

### skills/

`skills/<skill-name>/SKILL.md`, with the usual `name` and `description`
frontmatter. These skills load for every run invoked as this agent, ahead of
the project's and the user's own skills, so the agent can ship a skill that
overrides a same-named one. A run that turns skills off loads none of them.

## Invoking an agent

Two ways, both landing on the same run configuration:

- Write `@agents:<name>` in a user message. The message's run is invoked as
  that agent. The link also writes the agent's description into the graph
  above the message, where later runs read it as context.
- Open the custom inference dialog (`X` on a block, or shift with the message
  submit key) and pick the agent in the Agent row. Leaving it at None means
  the ask decides: the message's own `@agents:` reference, if any.

A summarization run is never invoked as an agent.

Naming an agent no shelf holds fails the run with `unknown agent: <name>`
rather than quietly running without one, so a deleted agent shows up as a
broken reference instead of a silently different behavior.

## Editing an agent

1. Resolve the name to the directory a run would use: the project's copy
   first, then `~/.weaver/agents`, then the app's bundled shelf. A bundled
   agent is edited by copying it to `~/.weaver/agents` first.
2. Edit the file that owns the behavior. Instructions go in `INSTRUCTION.md`,
   a new capability in `tools/`, reusable procedure in `skills/`.
3. Rerun the message that invokes the agent. Edits are read per run; there is
   no restart and no build step.

To check the merge, list the shelves: `ls ~/.weaver/agents` and
`ls .weaver/agents` from the project root, plus whatever the app ships. If two
agents share a name, the more specific one is what runs.

## Common mistakes

- Putting an agent in `.weaver/plugins`. Plugins are code that registers
  kinds and tools for every run; an agent is a run configuration picked per
  message.
- Writing an agent with no `DESCRIPTION.md`. It still works, but both pickers
  show a blank line and the material block has nothing to say about it.
- Editing a bundled agent in place. Its directory is inside the app; the edit
  is lost on update and the file may be read-only. Copy it first.
- Repeating the harness prompt in `INSTRUCTION.md`. It is appended, not a
  replacement, so restating it wastes context and dilutes the part that is
  specific.
- Using `ctx.wait` on a kind that has no `resume`. The tool gets null instead
  of an answer, so say so in text rather than parking a run nothing can
  release.
