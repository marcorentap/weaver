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
    ipc/           one file per IPC group: agent, artifacts, chat, clipboard, export, links, media-protocol, plugins, settings, hindsight
    lib/           run-agent.ts (run engine), agent-runtime.ts, agent-dir.ts, agent-resources.ts,
                   read/write/edit-source.ts, project.ts, plugins.ts, store.ts, seed.ts, ssh.ts, symbol-index.ts,
                   context-wire.ts (graph → provider payload), model-modalities.ts (does the model
                   take and/or make images), image-generation.ts (image API client)
  preload/         the only typed bridge exposed to the renderer
  renderer/src/    React UI (no Node access)
    lib/           chat-store, live-graph (client model), inference, keymap, pages, routes, settings, viewport, links
    components/, blocks/, pages/
  shared/          types shared across processes: ipc-contract, agent-events, blocks/kinds, provider-routing
packages/core      Block graph model + kind system (no app deps)
packages/store     SQLite persistence (node:sqlite)
packages/plugins   Plugin contract (definePlugin)
plugins/*          bundled plugins: rich-media, user-input, agent-seerxng, agent-hindsight, agent-subagents
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

- `Block` = `{ id, kind, label, createdAt, modifiedAt, next, children, data, hidden?, asked? }`.
  The graph is a binary tree used as a linked list of linked lists: `next` is
  the following sibling, `children` the first nested block. **Order is stored,
  never derived from timestamps.** `hidden` excludes a subtree from rendering,
  snapshots, and merged environment, without deleting it. `asked` records that
  a run was anchored on this block with its own document as the ask, which is
  the one thing the kind cannot say: a run's ask is always a `user` message,
  so a note or a reply someone ran on reads as a user turn afterward instead
  of as `developer` material — otherwise a replay of that graph is a message
  shorter than the request that produced it.
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
  provider's `onPayload` hook, ahead of pi's own first turn. A kind may also
  put pictures on a turn (`images`), which travel as URIs and are read and
  attached as content parts by `main/lib/context-wire.ts` — only when the
  model takes image input (`main/lib/model-modalities.ts`: the endpoint's own
  `/models` listing, falling back on pi's catalog), and never at the cost of
  the text description the snapshot already wrote. The `read` tool answers a
  picture the same way: an image file (see `attachableImage` in rich-media)
  comes back as an image content part when the model takes one, and as a line
  naming the file when it does not — never as the file's bytes read as text.
  Every run's
  material goes through that same path — `transcriptAbove` (the graph above a
  block), `messagesOfBlocks` (a summarization's targets), `messagesOfGraph`
  (the whole visible graph, for naming a session) — so a run over an explicit
  set of blocks reads its material with the roles the blocks already hold,
  never as a flattened string. `transcriptAbove` is `messagesAbove` with the
  blocks that came off a wire put back in the shape they travelled in: a
  `tool` block is not a `developer` paragraph about a call but the assistant
  turn's `tool_calls` entry (`context-wire.ts` reads it as `wire`) answered by
  a `tool` message quoting `call_n`, and an assistant turn keeps its
  `reasoning`. That is what makes a new run's request a prefix of the run
  before it, which is the only condition under which a provider's prefix cache
  can hit at all; `messagesAbove` stays the document projection, for a block
  read on its own. Call ids are minted per serialization
  (`transcriptOfBlocks`) and pi's own are renamed to the same scheme
  (`canonicalToolCallIds`) so the two sides agree. Two things a graph's order
  cannot say are recorded on the block instead: `turn` names the assistant
  message a call came from (a run names it from the message's own `tool_calls`
  and the block keeps it), because one message with three calls and three
  messages with one each look identical in the graph but are not the same
  request, and reasoning is rejoined with a newline exactly as pi joins a
  message's thinking blocks. `canonicalMessages` is the one shape both
  directions write, applied last: a message's `content` is a string unless
  something in it is not text, call ids are canonical, arguments are re-encoded
  with sorted keys, and a conversation that carries reasoning at all gives
  every assistant message a `reasoning_content` (empty where none was
  recorded), which is what an endpoint that requires the field expects.
  `@file:` and
  `@skill:` references a user message attaches are not sent with the run at
  all: main resolves them (`main/lib/links/material.ts`) and the renderer
  writes each one into the graph as a `text` block of its own, just above
  the message, so the message's own run — and every run after it — reads the
  material as ordinary blocks above its turn: a skill in full, a file as the
  same truncated, tree-sitter-indexed view the `read` tool gives.
- A **kind** (`defineKind`) is defined _entirely_ by a zod schema plus:
  `role` (the conversational role its content takes in a run's context; omit
  for `developer`), `context` (false to keep the kind's blocks out of a run's
  context; omit to include them), `snapshot` (the block as a document, for
  previews and summaries), `images` (pictures the block holds beside that
  document, as URIs — the request builder reads them and attaches them as
  content parts when the model takes image input; omit for a kind with no
  picture), `turns` (the block as conversation, for a kind
  whose one block spans more than one speaker; omit for the ordinary single
  turn of `role` + `snapshot`), `wire` (the block's form on the wire, where a
  run should replay what happened instead of describing it: a tool call, with
  the pictures its result carried, or reasoning that rides on the next
  assistant turn; omit for a kind that never had one), `resume` (whether and how a run stopped on
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

`main/lib/run-agent.ts` (`runAgent`) is the run engine, called by the Electron
IPC handler. It mounts a `weaver` provider on pi's `ModelRuntime`
(endpoint/key from the request) and either runs plain (no tools, used for
summarization) or creates a full pi session with our custom tools
(read/write/edit/display_media) plus plugin tools and plugin-provided kinds.

- A model whose output is pictures is not a chat model, so such a run takes a
  different path before anything is mounted: `modelOutputsImages`
  (`model-modalities.ts`, the endpoint's `/models` output modalities, falling
  back on pi's image catalog) sends it to the endpoint's image API instead of
  a completion. `main/lib/image-generation.ts` posts the request's whole ask
  as one prompt — the graph above the block, then the block — plus the
  anchoring block's own pictures as reference images, and the run writes each
  returned base64 picture into the session's artifacts directory and emits it
  as a `media` block. Nothing streams and no tool is mounted: the pictures or
  an error are the whole of the run.

- Resources (skills, extensions, context files) are discovered from `~/.agents`,
  `<cwd>/.agents` and `<cwd>/.weaver`, never from pi's own directories. The
  three are one precedence chain — `.weaver` over `.agents` over
  `~/.agents` — with `AGENT_DIR` honored.
- The system prompt is `main/agent/system-prompt.md`, injected via
  `WEAVER_SYSTEM_PROMPT`, replacing pi's default.
- Events are zod-validated in `shared/agent-events.ts` and streamed to the
  renderer as a discriminated `AgentEvent` union until `done`/`error`. A
  terminal `error` is only emitted once pi's session settles after auto-retry,
  never on the first failed attempt.
- `display_media` deliberately only turns a URI into a media block, so the model
  can't hand-write a kind's own fields.
- Prompt caching is the reason the serialization is shaped the way it is, and
  three things keep it working. Compaction is off
  (`settingsManager.setCompactionEnabled(false)` in `run-agent.ts`): pi
  compacts by summarizing a conversation and replacing its history, which
  rewrites every token after the system prompt, so a run that compacts pays
  for its whole context again and so does every later run replaying it. The
  graph is the answer to a context that grew too large — a person deletes or
  summarizes what they no longer want, once. `transcriptAbove` is what makes
  a new run's request a prefix of the last one's; anything recorded as prose
  instead of as the wire shape it came from breaks the prefix from that point
  on. And the provider has to be told to cache: pi places Anthropic
  `cache_control` breakpoints only when it can tell the provider is OpenRouter
  from the registered id, and ours is always `weaver`, so `run-agent.ts` names
  `compat.cacheControlFormat` itself for an OpenRouter Anthropic route;
  OpenAI's `prompt_cache_key` is routed from the renderer's `cacheKey` (the
  graph's root block) because a pi session id is new every run and would
  scatter one conversation across hosts by design. `context-wire.ts` sends
  that key only to the endpoint that documents the field. Two turns exist on
  the wire that no block is, and both are rebuilt by `context-wire.ts`: the
  pictures a tool result carried, which the wire puts in a `user` turn after
  the `tool` message (one per run of consecutive results, as pi builds it),
  and the ask itself, which is a `user` turn whatever kind the anchored block
  belongs to (`block.asked`).
- A tool can start another run inside its own call:
  `ctx.spawnAgent(messages)` (see `ToolRunContext`) runs a nested agent on
  the messages it is given, inheriting the spawning run's request (endpoint,
  model, tools, discovery flags, merged environment), so a tool mounted on
  one run is mounted on the next and spawning recurses. The nested run's
  events travel the same channel, each carrying a `nest` scope that names
  the spawning call's wire id — its tool and question ids namespaced by that
  same id, so nothing collides — and the renderer appends each event under
  the tool call's own block as `children`. `main/lib/run-agent.ts` rewrites
  the events; `live-graph.ts` routes each one by its `nest` scope into the
  frame that scope's text stream belongs to, and locks a locked block's
  children with it. Because the scope rides each event rather than a scope
  the stream opens and closes, two subagents spawned in one batch run at the
  same time without their transcripts merging or one another's blocks
  holding them apart. The transcript is a record, not
  the parent's context: a tool block snapshots only its own call and
  output, and `messagesAbove`/`messagesOfGraph` never descend into children,
  so the parent model receives the subagent's final answer alone — as the
  tool result, and later as that one line in the tool block's snapshot.
  Nothing of the subagent's reasoning, its tool calls, or the messages it
  was handed ever reaches the parent, and the subagent sees only the
  `messages` it was given rather than the graph above the spawning block.
  Both sides are told the answer is one-way: the tool's description tells a
  spawner to require a final answer that stands on its own, and
  `SUBAGENT_ANSWER_NOTE` says the same to the subagent in its own context, so
  the contract holds even when the instruction forgets it.
- A run can stop partway. A tool that calls `ctx.wait(kind, data, label)`
  materializes that block and leaves the agent loop parked inside its own call;
  `runAgent` emits a `wait` event (not `block`), and the caller resolves it
  through `AgentRunContext.wait`, which the IPC handler wires to
  `agent:run:answer`. On the renderer side the block lands as the run's output
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
