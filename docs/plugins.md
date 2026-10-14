# Plugins

A plugin is how anything is added to weaver: a new block kind, a new tool, a new
setting. There is no distinction between the app's own kinds and a plugin's,
which is why the bundled plugins live in `plugins/*` as ordinary workspace
packages rather than inside `apps/desktop`.

The contract is small and lives in `packages/plugins/src/index.ts`.

```ts
export type Plugin = {
  id: string; // stable id, and the settings key
  name: string;
  description: string;
  settings?: PluginSettingField[];
  kinds?: BlockKind[];
  tools?: PluginTool[];
};
```

`definePlugin` is an identity function whose only job is to type-check the
literal without widening it. There is no lifecycle, no init hook and no
registration call: a plugin that exports its kinds and tools has done everything
it needs to.

## Settings

A plugin declares its settings and never stores them. A field is a string, a
number or an option, each with a key, a label, a description and optionally a
`placeholder`, a `secret` flag for credentials, and a `validate` function.

The app binds them. Values live in the store under one JSON blob per plugin id
(`weaver.plugins.<id>`), the settings page renders them generically from the
declaration, and a tool reads its own configuration through `ctx.getSetting`
rather than reaching for the app's store. Since the renderer cannot run a
`validate` function across the IPC boundary, a draft value is sent back to main
to be checked.

## Tools

```ts
type PluginTool = {
  name: string;
  label: string;
  description: string | string[];
  parameters: Record<string, unknown>; // a TypeBox object schema
  sequential?: boolean;
  execute(
    args,
    ctx,
  ): Promise<{ content: string; details: Record<string, unknown> }>;
};
```

`sequential` asks the SDK to run the batch containing this tool one call at a
time. A subagent tool does not need it: a nested transcript is scoped to the
call that spawned it, so concurrent subagents land in their own branches.

Throwing from `execute` reports failure. The agent loop turns a throw into a
failed tool result, so a rejected call is visible as a failed one rather than
disappearing.

`PluginTool` is deliberately SDK-agnostic. `main/lib/run-agent.ts` wraps each one
in the SDK's own tool shape at mount time, so the plugin package depends on
neither pi nor Electron.

### What a tool can do to the graph

`ToolRunContext` is what `execute` receives:

```ts
{
  getSetting(pluginId, key): string | undefined;
  addBlock?(kind, data, label): void;
  wait?(kind, data, label): Promise<string | null>;
  spawnAgent?(messages): Promise<string>;
}
```

Every one of the last three is optional, and a tool must handle their absence.
`ctx.addBlock` appends a block right after the run's anchor, with the data
validated against the kind. A bare tool host that has nowhere to put a block
omits it, and the tool falls back to text.

`addBlock` and `wait` are not exclusive. They exist because a run lives in the
graph it appends to, so a tool's output can be a block rather than a string.

`wait` is the one that stops the run. It materializes a block, emits a `wait`
event, and leaves the agent loop parked inside the tool call until the block's
kind answers `resume(state)` with something other than null. It resolves with
that text as an answer, or with null when nobody will answer: no
materialization, a cancelled run, a deleted block. Null is not an empty answer
and a tool should say so.

`spawnAgent` runs a nested agent on the messages it is given and returns the
final answer. See [`runs.md`](./runs.md) for the nesting, the id namespacing and
why the parent only ever sees the answer.

## Loading

`main/lib/plugins.ts` loads plugins from two places.

The bundled ones are imported directly in the main process:
`rich-media`, `agent-seerxng`, `agent-hindsight`, `agent-subagents` and
`user-input`.

Anything else is loaded from `~/.weaver/plugins` (or wherever the
`weaver.plugins.dir` setting points). Each immediate subdirectory that is not
already a built-in id is bundled with esbuild and imported from a
`data:text/javascript` URL, resolving from the app's own `node_modules`. That
means a drop-in plugin is one directory with `src/index.ts` in it, needs no
build and no `node_modules` of its own, and works without restarting anything.
One broken plugin is warned about and skipped rather than silencing the rest.

The resulting bundles are memoized and rescanned on request. `build()` produces
the two things the rest of the app asks for: `kinds`, a registry folding
`coreKinds` and every plugin's kinds together, and `tools`, the flat list of
plugin tools. Plugins load before the first window so that store writes validate
against the full kind registry from the start.

## The bundled plugins

### rich-media

The four kinds that are not core: `user` and `assistant` as the two
conversational roles, `tool` for a finished tool call (`{ name, args, output, ok
}`, snapshotting as the call and its output, with an `edit` call's diff
highlighted as a diff), and `media` for a file or video reference
(`{ uri }`, snapshotting as a type and a URI, and carrying the picture as an
`images` URI when it is one a provider takes).

It also supplies the file-language map used for syntax highlighting and the
media helpers the rest of the app leans on: `parseMediaUri`, `youtubeVideoId`,
`resolveMediaUri`, `mediaInfo` and `attachableImage`, which is the one place
that decides whether a path names an image a model could be sent.

### user-input

One kind, `multichoice`, and one tool, `ask_user`.

The kind holds a prompt, the options offered, what was picked, whatever was
typed into "Other", an additional note, and an `answered` flag. Its interesting
part is that it holds both sides of the exchange: `turns` renders the question
as an assistant turn and the answer as a user turn, so a question and its answer
stay in one block without the model losing track of who said what. Its `resume`
returns null until `answered` is set, which is exactly the condition the
renderer watches for.

The round trip starts with the model calling `ask_user`. The tool materializes
the question block through `ctx.wait` and stops. The person picks options, and
setting `answered` makes `resume` return the answer as bullets, which releases
the run, and the tool's result is that text. If nothing can carry the block, or
nothing will answer it, the tool says so and the model continues without an
answer.

### agent-seerxng

One tool, `web_search`, against a self-hosted SearXNG instance. The one setting
is its URL, and the tool throws when it is blank. Results come back as numbered
title, URL and snippet.

### agent-hindsight

Four tools over a Hindsight memory bank: `retain`, `recall`, `reflect` and
`list`. Its settings are the base URL, an API key and a bank id.
`main/ipc/hindsight.ts` exposes retain to the renderer as well, so a memory can
be saved from the UI without going through a run.

### agent-subagents

One tool, `spawn_subagent`, taking an array of `{ role, content }` messages. It
requires `ctx.spawnAgent`, returns the subagent's answer as its own result, and
lets several calls in one batch run at once, each transcript under its own
call's block.

## Kinds the renderer knows about

The two registries are separate on purpose.

`shared/blocks/kinds.ts` is the runtime registry: `coreKinds` plus the kinds the
bundled agent plugins contribute. It is what the store validates against and
what the message walks consult.

`renderer/src/blocks/views.tsx` is the view map, keyed by kind id, with entries
written by hand. There is no dynamic view registration, so a plugin kind with no
entry renders as `unregistered kind: <id>`.

The gap is intentional and the asymmetry is the point. A missing view is a
cosmetic problem in the UI. A missing snapshot would silently change what the
model reads, so unknown kinds throw there instead of rendering something
plausible.
