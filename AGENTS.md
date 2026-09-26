# Weaver

Desktop app that treats LLM context as an editable document instead of an
append-only log. Context is a tree of **blocks** (the weaver graph); each block
is one piece of context, and an inference run is anchored at a point in that
tree, seeing only what precedes it.

Electron + React 19 + TypeScript, pnpm/turbo monorepo, MIT.

## Layout

```
apps/desktop/src/
  main/            Electron main process (owns disk, SQLite, subprocesses)
    index.ts       entry; windows, protocol registration
    agent/         system-prompt.md — the run instructions (read into WEAVER_SYSTEM_PROMPT)
    ipc/           one file per IPC group: agent, chat, links, media-protocol, plugins, remote, settings, hindsight
    lib/           run-agent.ts (run engine), agent-runtime.ts, agent-dir.ts, agent-resources.ts,
                   read/write/edit-source.ts, project.ts, plugins.ts, store.ts, seed.ts, ssh.ts, symbol-index.ts
    remote/        server.ts (HTTP + streaming agent runs), instance.ts, keys.ts
  preload/         the only typed bridge exposed to the renderer
  renderer/src/    React UI (no Node access)
    lib/           chat-store, live-graph (client model), inference, keymap, pages, routes, settings, viewport, links
    components/, blocks/, pages/
  shared/          types shared across processes: ipc-contract, agent-events, blocks/kinds, provider-routing
packages/core      Block graph model + kind system (no app deps)
packages/store     SQLite persistence (node:sqlite)
packages/plugins   Plugin contract (definePlugin)
plugins/*          bundled plugins: rich-media, user-input, agent-seerxng, agent-hindsight
```

Dependency direction is one-way: `desktop → plugins → store/core → plugins package`.
Renderer must never value-import `@repo/store` (it pulls in `node:sqlite`); use
`import type`.

## Commands

Requires Node >= 24 and pnpm (see the root `package.json` `engines` and
`packageManager` fields). If they are not on your PATH, fix that outside the
repo — do not bake a machine-specific bin directory into this file.

```sh
pnpm install          # postinstall build scripts are allowlisted in pnpm-workspace.yaml
pnpm dev              # turbo dev (apps/desktop: electron-vite dev)
pnpm build
pnpm lint             # eslint --max-warnings 0; zero warnings tolerated
pnpm check-types
pnpm format           # prettier over **/*.{ts,tsx,md} — run before committing
```

There is no test runner and no test suite. Verify by building, type-checking,
and running the app.

## Core model

Everything lives in `packages/core`.

- `Block` = `{ id, kind, label, createdAt, modifiedAt, next, children, data, hidden? }`.
  The graph is a binary tree used as a linked list of linked lists: `next` is
  the following sibling, `children` the first nested block. **Order is stored,
  never derived from timestamps.** `hidden` excludes a subtree from rendering,
  snapshots, and merged environment, without deleting it.
- Tree operations (`insertBlock`, `moveBlock`, `removeBlock`, `positionOf`,
  `assertTree`, …) are pure `graph → graph` functions. Use them; never rewrite
  links by hand. `assertTree` is the invariant: one root, no loops, nothing
  unreachable.
- Snapshots are how a block becomes text: `snapshotBlock` (one block, its
  label as prefix). Unknown kinds throw rather than guess. A snapshot is the
  block as a document — a preview, or the fallback prompt of a block with
  nothing of its own to answer — where what a run sends as context is the
  message view below. Walking the graph above a block is `precedingBlockIds`
  (`mergedEnvironment` folds environment blocks by the same walk, so context
  and environment cannot disagree about what comes before a block).
- A run sends that view turn by turn, not as one blob: `messagesAbove` returns
  the blocks preceding a block as `{ role, content }`, the role taken from
  each block's kind (`user` and `assistant` kinds are those turns; everything
  else is `developer`), or from a kind's own `turns` when one block holds both
  sides of an exchange (`multichoice`: the question as assistant, the answer as
  user). A kind may also opt out of a run's context entirely (`context: false`;
  `environment` does, since its variables already reached the run), which drops
  its blocks wherever they sit — the option carries down `snapshotBlock`'s
  recursion. The anchoring block contributes its own turns the same way
  (`messagesOfBlock`), the last of them being what the run is prompted with;
  `main/lib/run-agent.ts` splices the rest into the request pi built, via the
  provider's `onPayload` hook, ahead of pi's own first turn. Every run's
  material goes through that same path — `messagesAbove` (the graph above a
  block), `messagesOfBlocks` (a summarization's targets), `messagesOfGraph`
  (the whole visible graph, for naming a session) — so a run over an explicit
  set of blocks reads its material with the roles the blocks already hold,
  never as a flattened string. `@file:` and
  `@skill:` references a user message attaches are read there too — the
  renderer has no filesystem — and appended as their own `developer` messages
  just before that first turn (`main/lib/references.ts`): a skill in full, a
  file as the same truncated, tree-sitter-indexed view the `read` tool gives.
- A **kind** (`defineKind`) is defined _entirely_ by a zod schema plus:
  `role` (the conversational role its content takes in a run's context; omit
  for `developer`), `context` (false to keep the kind's blocks out of a run's
  context; omit to include them), `snapshot` (the block as a document, for
  previews and summaries), `turns` (the block as conversation, for a kind
  whose one block spans more than one speaker; omit for the ordinary single
  turn of `role` + `snapshot`), `resume` (whether and how a run stopped on
  one of its blocks starts again; omit for a kind no run can be paused on),
  `hooks` (named async state→state functions),
  `callbacks` (declarative references to another block's hook), `schedule`
  (self-driving timer request), `defaults`. Everything parses through the
  schema, so no consumer ever sees partially-specified state.
- Hooks get a `HookContext`: `call` another block's hook, read `graph`,
  `registry`, and mutate via `addBlock`/`clearChildren` only.

Adding a block kind means adding a `defineKind` to a plugin's `kinds` (or
`packages/core/src/kinds` for core kinds) — the renderer, snapshots, and store
validation pick it up from the registry.

## Plugins

`packages/plugins/src/index.ts` defines the contract (`definePlugin`: `id`,
`name`, `settings`, `kinds`, `tools`). Bundled ones are imported directly in
`main/lib/plugins.ts`; additional directories are loaded from
`~/.weaver/plugins` (override via the `weaver.plugins.dir` setting).

- Settings fields are declared, never persisted by the plugin — the app binds
  them to its own store (`plugins.*` IPC).
- Tools are SDK-agnostic (`PluginTool`: TypeBox `parameters`, `execute(args, ctx)`
  returning `{ content, details }`). `ctx.addBlock` is optional; fall back to
  text when the harness can't materialize blocks. `ctx.wait` is the same shape
  for a question the tool cannot answer itself: it materializes a block and
  parks the run inside the tool call until that block's kind resumes it.

## Agent runs

`main/lib/run-agent.ts` (`runAgent`) is caller-agnostic — used by the Electron
IPC handler and by the remote HTTP server, so a remote run acts on the
_server's_ filesystem. It mounts a `weaver` provider on pi's `ModelRuntime`
(endpoint/key from the request) and either runs plain (no tools, used for
summarization) or creates a full pi session with our custom tools
(read/write/edit/display_media) plus plugin tools and plugin-provided kinds.

- Resources (skills, extensions, context files) are discovered from `~/.agents`
  and `<cwd>/.agents`, never from pi's own directories. `AGENT_DIR` is honored.
- The system prompt is `main/agent/system-prompt.md`, injected via
  `WEAVER_SYSTEM_PROMPT`, replacing pi's default.
- Events are zod-validated in `shared/agent-events.ts` and streamed to the
  renderer as a discriminated `AgentEvent` union until `done`/`error`. A
  terminal `error` is only emitted once pi's session settles after auto-retry,
  never on the first failed attempt.
- `display_media` deliberately only turns a URI into a media block, so the model
  can't hand-write a kind's own fields.
- A run can stop partway. A tool that calls `ctx.wait(kind, data, label)`
  materializes that block and leaves the agent loop parked inside its own call;
  `runAgent` emits a `wait` event (not `block`), and the caller resolves it
  through `AgentRunContext.wait`, which the IPC handler wires to
  `agent:run:answer` and the remote server omits (so a remote run degrades to
  the tool's own text). On the renderer side the block lands as the run's output
  and its engine watches it: `live-graph.ts` holds it in `pendingWaits`, exempts
  it from the run's lock (`lockedBlockIds`) because answering _is_ an edit, and
  answers the tool the moment the block's `resume` reads a value out of the
  updated state. A run that is cancelled, whose renderer is gone, or whose
  question is deleted is released with null instead of hanging.

## Conventions

- Comments explain **why**, in full prose sentences, often at length. This
  codebase documents its reasoning inline; match that register. Do not add
  comments that restate the code.
- Types are inferred from zod schemas (`z.infer`); a schema is the single
  source of truth, and `parse` is the only way in.
- IPC is grouped by domain and typed end-to-end via `shared/ipc-contract.ts`
  and the preload bridge. Add a method there, not an ad-hoc channel.
- Prettier is the formatter; ESLint runs with `--max-warnings 0`.
- Keep renderer code free of Node and of `@repo/store` value imports.

## Environment

| Variable               | Read by    | Meaning                                                  |
| ---------------------- | ---------- | -------------------------------------------------------- |
| `WEAVER_PWD`           | weaver     | project dir for a run; relative paths resolve against it |
| `WEAVER_STORE`         | store      | SQLite path (default `~/.weaver/store.db`)               |
| `PI_CODING_AGENT_DIR`  | agent-dir  | agent dir (default `~/.agents`)                          |
| `WEAVER_SYSTEM_PROMPT` | run engine | replaces the default pi system prompt                    |

`WEAVER_PWD` is merged from the environment blocks above a block
(`mergedEnvironment`), and is the same root used by `@file:`/`@skill:` link
completion and `weaver-media://` resolution.

## Commits

Terse single-line subjects, no body, imperative, conventional prefix:

```
feat: discover agent resources from .agents, not .pi
fix: keep the run shown as running while pi auto-retries
refactor: drop bank param from hindsight agent tools
```

Do not commit unless asked.
