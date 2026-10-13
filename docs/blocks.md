# Blocks and kinds

Everything in weaver is a block, and every block is one of a small number of
kinds. This document covers the graph itself, what a kind is allowed to declare,
and how a block becomes something a model reads.

The code is `packages/core`, which has no dependency on the app at all.

## The block

```ts
type Block = {
  id: BlockId; // randomUUID, ordering never comes from it
  kind: string; // looked up in the kind registry
  label: string; // the human-facing name in the gutter
  createdAt: number;
  modifiedAt: number;
  next: BlockId | null; // following sibling
  children: BlockId | null; // first child
  data: unknown; // parsed by the kind's schema
  hidden?: boolean; // excluded from rendering and from runs, not deleted
};
```

The graph is a binary tree used as a linked list of linked lists. `next` is the
sibling after a block, `children` is its first child, and a block's remaining
children hang off that first child's `next` chain. Every reader uses the same
walks: `chainIds` for a sibling run, `childIds` for a parent's children,
`subtreeIds` for a block and everything under it, `precedingBlockIds` for
everything that comes before a block in document order.

Order is stored. That is the whole reason the timestamps are not load-bearing,
and why `insertBlock`, `moveBlock` and `removeBlock` are the only way structure
changes. They are pure `graph → graph` functions. `assertTree` is the invariant
they preserve: exactly one root, no cycles, nothing unreachable. It runs on
every write.

Two smaller pieces of the model matter more than they look:

**A position.** Tree operations take a `Position`, either after a sibling
(`afterId`) or as the first child of a parent (`parentId`). The renderer
computes one for every insertion, including the gaps between rows.

**Hidden.** A hidden block is excluded from rendering, from snapshots and from
merged environment, and stays in the graph. It is the mechanism behind the
"thinking" block a run appends, which you can expand when you want it.

## Kinds

A kind is defined entirely by `defineKind`, in `packages/core/src/kind.ts`. It is
a zod schema plus a set of optional behaviours. Everything a consumer touches
goes through the schema, so no code anywhere sees a half-specified block.

```ts
defineKind({
  kind: "assistant",
  role: "assistant",          // user | assistant | developer (default developer)
  context: true,              // false keeps these blocks out of every run
  schema,
  snapshot(state, ctx),       // the block as a document
  images(state, ctx),         // pictures beside that document, as URIs
  turns(state, ctx),          // the block as conversation, when one block holds two speakers
  resume(state),              // the text a parked run continues with, or null
  hooks,                      // named async state -> state functions
  callbacks,                  // declarative pointers at another block's hook
  schedule(state),            // self-driving timer request
  defaults,
});
```

The fields fall into three groups.

**How a block reads as text.** `snapshot` renders the block as a document, used
for previews, for summaries, and as the fallback prompt of a block with nothing
of its own to answer. It receives a `SnapshotContext` with the block, a
`nested(id)` helper for rendering a child in place, and the child ids. An
unknown kind throws here rather than guessing, because a wrong snapshot silently
changes what the model reads.

**How a block reads as conversation.** `role` says which speaker its text is.
`turns` overrides that when one block holds both sides of an exchange, which is
how a question and its answer stay in one block while still reaching the model
as an assistant turn followed by a user turn. `context: false` removes the
kind's blocks from every run entirely, carrying down through the snapshot
recursion so a nested block cannot sneak back in.

**How a block acts.** `hooks` are named state functions. A `callbacks` entry
declares that this block can call a hook on another block, which is what makes a
button in the UI without any UI code in the plugin. `schedule` asks the app to
run a hook on an interval. `resume` is what lets a run park on a block until a
person answers it.

## Snapshot against message

These are two different questions and the code keeps them apart.

A snapshot is "what is this block, as a document". `snapshotBlock(graph, id,
kinds)` answers it, and `snapshotContext` gives the kind what it needs to walk
into its children.

A message is "what turn does this block contribute to a run". The four
functions in `packages/core/src/messages.ts` answer it:

| Function                              | Reads                                         |
| ------------------------------------- | --------------------------------------------- |
| `messagesAbove(graph, id, kinds)`     | everything preceding the block, turn by turn  |
| `messagesOfBlock(graph, id, kinds)`   | the anchoring block's own turns               |
| `messagesOfBlocks(graph, ids, kinds)` | an explicit set, for a summarization          |
| `messagesOfGraph(graph, kinds)`       | the whole visible graph, for naming a session |

Every run goes through one of these, so a run over an explicit set of blocks
reads them with the roles they already hold rather than as one flattened string.

## Environment

The `environment` kind holds `KEY=value` text. It declares `context: false`,
because its variables reach a run another way: `mergedEnvironment(graph, id)`
walks the `environment` blocks above a block, closer ones overriding farther
ones, and the result becomes the run's environment. In a fresh session that walk
is where `WEAVER_PWD` comes from, and it is what makes a run's working
directory, an `@file:` link's completion root and a media path's resolution all
agree about which project they are in.

Because both walks use `precedingBlockIds`, context and environment cannot
disagree about what comes before a block.

## Adding a kind

Kinds come from plugins. Add a `defineKind` to a plugin's `kinds` array, and the
registry, the store's validation and every run pick it up. Two things do not
come for free:

- **A snapshot.** A kind with no `snapshot` throws when it is read as a
  document, so this is required in practice.
- **A renderer view.** Views are registered by hand in
  `renderer/src/blocks/views.tsx`, so a new kind renders as `unregistered kind:
<id>` until an entry is added. That is a cosmetic gap in the UI, and
  deliberately not a fatal one, since the model still reads the block correctly.

See [`plugins.md`](./plugins.md) for the plugin contract and the kinds that ship
with the app.
