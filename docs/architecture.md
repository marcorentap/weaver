# Weaver architecture

An ordinary coding agent treats context as an append-only log: you send messages,
they pile up, and the only way to change what the model sees is to start over.
Weaver treats the same context as a document you can edit. Write a turn, edit an
earlier one, delete a bad tool call, restructure the whole thing, and the next
inference reads whatever the document now says.

The unit of that document is a **block**. Blocks form a tree (the weaver graph).
An inference run is anchored at one block and sees only what precedes it in that
tree. Nothing is accumulating behind your back: if a run should not see
something, you remove it from the graph.

This document is the overview. Four more go deeper:

| Doc                            | Covers                                                    |
| ------------------------------ | --------------------------------------------------------- |
| [`blocks.md`](./blocks.md)     | the graph, kinds, snapshots against messages, environment |
| [`runs.md`](./runs.md)         | one inference, from keypress to appended blocks           |
| [`plugins.md`](./plugins.md)   | the plugin contract, the bundled kinds and tools          |
| [`desktop.md`](./desktop.md)   | Electron shell, IPC, storage, media, links                |
| [`renderer.md`](./renderer.md) | the live graph engine, the ledger, views, keys, settings  |

## The shape of the system

Weaver is an Electron app. The split between its two processes is the first
thing to understand, because it is where most of the design follows from.

The **renderer** holds the live graph. It owns the session you are looking at,
every block in it, the cursor, and the run that is currently streaming into it.
It has no filesystem and no database. Everything it knows arrived over IPC.

The **main process** owns everything that touches the outside world: the SQLite
store, the provider endpoints, the filesystem tools, subprocesses, the media
protocol. It has no view of the live graph. What it gets for a run is a flat list
of messages the renderer already serialized, plus the request parameters.

That asymmetry is deliberate. The graph is a UI artifact that changes on every
keystroke, so it lives where the keystrokes are. Everything durable or dangerous
lives where a renderer compromise cannot reach it.

```
┌─ renderer (React 19, no Node) ──────────────────────────────┐
│  live graph engine  ·  block views  ·  keymap  ·  shell      │
│                        window.api                            │
└───────────────────────────┬──────────────────────────────────┘
                            │  preload bridge (typed, contextIsolated)
┌───────────────────────────┴──────────────────────────────────┐
│  main (Electron)                                             │
│    ipc/      one file per domain, all typed                  │
│    lib/      run-agent · context-wire · store · tools ·      │
│              media protocol · links · agent resources        │
└───────┬──────────────────┬──────────────────┬────────────────┘
        │                  │                  │
  packages/core      packages/store     packages/plugins
  graph + kinds      SQLite            plugin contract
        │                  │                  │
        └──────────┬───────┴──────────────────┘
                   │
              plugins/*   bundled kinds and tools
```

Dependencies run one way: `apps/desktop → plugins/* → packages/{store,core} →
packages/plugins`. The workspace packages ship raw TypeScript with no build step
of their own; `apps/desktop/electron.vite.config.ts` bundles them into the main
process and transpiles them for the renderer.

## The graph is the database

A graph is stored as one row per block, with two nullable self-references:
`next_id` for the following sibling and `children_id` for the first child. Order
lives in those links, never in timestamps, which is why any structural change
goes through the pure tree operations in `packages/core/src/block.ts`
(`insertBlock`, `moveBlock`, `removeBlock`) instead of being hand-written.

Every mutation is written whole. `Store.writeGraph` deletes the rows the input
set no longer has, upserts the rest, and before committing checks `assertTree`
(one root, no loops, nothing unreachable) and `assertValidData` (every block's
state parses against its kind's schema). A malformed block cannot reach disk, so
no reader ever has to defend against one.

## How a session works

The renderer holds a separate engine per session, cached at module scope in
`renderer/src/lib/live-graph-registry.ts`. Switching tabs does not tear down a
running inference, because the engine outlives the component that renders it.

Edits go to main first for anything the kinds must validate, then reflect
locally once main has accepted them, since main already ran the schema check.
Deletes and moves happen locally at once. None of this persists per keystroke:
the page debounces 800 ms, then saves the whole graph as one call.

## What a run sees

A run's material is the graph above its anchor, turned into turns by
`packages/core/src/messages.ts`. Each block contributes according to its kind:

- blocks whose kind is `user` or `assistant` become those turns;
- everything else, tool calls, files, notes, environment, arrives as a
  `developer` turn, material rather than conversation;
- a kind may hold both sides of an exchange and hand back its own turns;
- a kind may opt out of context entirely, and its blocks then reach no run at
  all (environment blocks do this, since their variables already reached the
  run as its working directory).

Before the text goes out, main asks the endpoint whether the model takes
pictures. If it does, the images a block holds ride along as content parts on
the appropriate turn, always beside the text description the block already
wrote. If it does not, the pictures are dropped and the description is all the
model gets.

## Where to look

| Question                                     | File                                                     |
| -------------------------------------------- | -------------------------------------------------------- |
| What is a block, and how does the tree work? | `packages/core/src/block.ts`                             |
| What may a kind declare?                     | `packages/core/src/kind.ts`                              |
| How does the graph become messages?          | `packages/core/src/messages.ts`                          |
| What is one inference run?                   | `apps/desktop/src/main/lib/run-agent.ts`                 |
| How is the graph persisted?                  | `packages/store/src/index.ts`, `schema.ts`               |
| What can the renderer ask main to do?        | `apps/desktop/src/shared/ipc-contract.ts`                |
| How does the UI hold a graph?                | `apps/desktop/src/renderer/src/lib/live-graph.ts`        |
| How does the app hold itself together?       | `apps/desktop/src/renderer/src/components/app-shell.tsx` |
| What are the rules for a run's instructions? | `apps/desktop/src/main/agent/system-prompt.md`           |
