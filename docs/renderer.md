# The renderer

The renderer is an ordinary React app with one unusual property: it holds the
whole live graph for every session you have open, and a run streaming into one
of them keeps streaming while you look at something else.

## Composition

`main.tsx` mounts `<App />`. `App` (`App.tsx`) is a provider stack and nothing
else:

```
SettingsProvider  ->  PluginsProvider  ->  ChatProvider  ->  AppShell
```

There is no URL for the app as a whole. Each tab owns a tree of panes, and each
pane mounts its own in-memory router. Chat session identity is a query
parameter, `?session=<id>`, on the chat route.

State is React context plus module-level external stores read through
`useSyncExternalStore`. There is no state library. Two stores outlive their
components and that is why they are module-level: the settings store and the
live graph registry. A run must survive a tab switch, and an engine held in
component state would be torn down along with the component, orphaning it.

`chat-store.tsx` holds the sessions list and one seed graph per session.
Requests are deduplicated and cached, so several panes opening the same session
share one round trip. A seed is only a starting point: once an engine exists
for a session, later calls to `getLiveGraph` ignore the argument, since the
engine's own state is more current than anything a render would hand it.

## The shell

`lib/shell.ts` is the layout model: `Tab`, `Pane`, and a `PaneNode` that is
either a leaf or a split, reduced by a pure `reduceLayout` over actions like
`new-tab`, `split-pane`, `focus-pane`, `move-focus` and `resize-pane`. None of
it knows about the graph.

`components/app-shell.tsx` renders that model. Each pane is a slot with its own
memory router, and each slot scopes its key layers to its own pane id, so only
the focused pane dispatches. Panes come with their own title bar, resize
handles, and a recorded route so navigation inside a pane survives a re-render.

`lib/pages.ts` is the page list (`chat`, `resources`, `settings`) with their
keys and paths, and it is the single source the tab bar reads. `resources` is a
placeholder for now.

## The chat page as a ledger

`pages/ChatPage.tsx` is the largest file in the app, and most of it is one idea:
the graph rendered as a ledger.

`chatNodes(graph)` turns the block graph into a tree of `ChatNode`, and
`flatten` walks it into a flat `Row[]` of `{ block, depth, parent, nested,
expanded }`, descending only into containers you have expanded. Each row is a
line of a gutter, an indented label column with a chevron and icons for locked,
waiting and hidden, and the kind's own row view, clipped at twelve lines unless
you expand it.

Every pair of rows, and both ends of the list, has an insert gap: a zero-height
hover target that inserts a block there. Its position is computed from the
neighbouring rows, so inserting between two lines of a nested subtree puts the
block in the right place rather than at the top level.

The cursor is a row index. Visual mode is a second anchor beside it. Actions on
a row come from the row's own view (`view.fields` declares which fields are
editable and what they are called), plus a fixed set: run an inference, run a
custom inference, summarize, answer a question, configure hooks and callbacks,
copy the content or the ID, edit the label, hide, delete.

There is no virtualization. Every row in the list is mounted, which is what
makes the row a direct handle on a block and the cursor a plain index.

## The live graph engine

`lib/live-graph.ts` is one mutable engine per session. It is plain state with
`subscribe` and `getSnapshot`, which is exactly the shape `useSyncExternalStore`
wants, and it is created and cached by session id in `live-graph-registry.ts`.

It wraps an ordinary `@repo/core` graph and adds what a running app needs:
which blocks a run is appending to, which blocks a run has parked on, the undo
and redo stacks, whether the graph has unsaved changes, and the mutating
operations. Every mutation checks the lock first, so a run's output region is
read-only while the run is live.

Typed edits are persist-first. Main validates a new field value against the
kind's schema, and only once it accepts does the engine reflect it locally.
Deletes and moves happen locally straight away and are sent along beside, since
there is nothing to validate. Durability is by autosave: the page debounces 800
ms on the graph identity and then saves the whole graph in one call.

Undo is local and structural, a stack of whole graphs sharing their unchanged
parts, capped at 100 entries. Several mutations made as one action are grouped
into one entry. A run's own appends and hook churn are not in that history,
since you did not do them.

`runInference`, `summarize`, `generateTitle` and `runHook` all live here too,
so the engine is the thing that talks to main, and the page only renders what
the engine says. [`runs.md`](./runs.md) covers what they do.

`lib/env.ts` is the one piece of the engine's neighbourhood worth calling out
separately: it reproduces a run's merged `WEAVER_PWD` for the block being
edited, so link completion in the message editor is rooted where a run from that
block would run.

## Block views

`blocks/views.tsx` is the kind to component map, keyed by kind id and written by
hand.

```ts
type BlockView = {
  Row: ComponentType<...>;      // the row in the ledger
  fields?: (block) => BlockField[];   // editable fields, with labels and hints
  Preview?: ComponentType<...>;  // the full-size view
  raw?: (block, graph) => string | null;  // a URL for the underlying file
  labelClass?: (block) => string;  // the label's color, by who produced the block
  copy?: (block) => { label; value } | null;  // the "Copy content" action
  answerable?: boolean;  // the block's menu offers the kind's answer dialog
};
```

The last three are per-kind behaviour the ledger would otherwise have to spell
out in a switch over kind ids: the color a block's label takes, the one string
`y` copies, and whether the block's actions menu offers an entry that opens the
kind's own answer dialog. Keeping them on the view means the page never names a
kind: once a kind has an entry (still written by hand, as above), the ledger
treats it exactly as it treats a bundled one.

`viewFor(block)` looks the kind up in the registry and parses the block's data
against the kind's schema before it renders anything. A parse failure swaps in
`invalidView`, which shows the message and takes its editable fields from the
raw data, so a malformed block stays repairable instead of becoming a dead row.
A kind with no view gets a fallback row naming the kind. Views are cached per
block in a `WeakMap`, since blocks are immutable.

`blocks/media.ts` holds the one renderer-only piece of media handling:
`mediaSrc(uri, pwd)` turns a YouTube URL, a `file:` URI or a scheme-less path
into something an element can load through the `weaver-media://` protocol.

## Keys

`lib/keymap.tsx` is a layered keyboard engine, in the Vim sense that the app is
driven by single keys and leaders rather than menus.

A component mounts a layer with `useKeyLayer`, and the layer is rewritten every
render so its bindings close over current state. A binding names a key combo, a
function, a help line, and optionally a leader layer, a scope, and a `modal`
flag that swallows unbound keys while it is open. Digit prefixes work, so `3j`
and `12G` do what they would in Vim, and a count expires after a moment so a
stray digit does not sit armed. Panes scope their layers, and only the focused
pane dispatches. `?` opens the help popup, generated from the bindings that are
actually mounted.

Text entry is excluded from all of this, and the few keys main has to intercept
before the page sees them are declared in `shared/keys.ts` rather than being
hardcoded on either side.

## Settings

`lib/settings.tsx` is a module-level store over one store key,
`weaver.settings`, holding the app's own preferences: appearance, the AI
provider's endpoint and key, inference defaults, summarization defaults. The
shape and every default are one zod schema; hydration parses the stored blob
through it, so a field an older blob is missing, or one holding a wrong-typed
value, falls back to its own default rather than resetting the whole object.
Writes are optimistic and fire the IPC without waiting.

`pages/SettingsPage.tsx` declares settings as data. A `SettingDef` is an option,
a number, a string, an info row or an action, flattened into rows and navigated
with the same key vocabulary as the rest of the app. The plugin section is
appended from the loaded plugins: each declared plugin field becomes a row of
this same shape, with its value read and written under `weaver.plugins.<id>`
and its validation delegated back to main.

`components/custom-inference.tsx` is the per-run dialog behind `X` and `S`. It
prefills from saved settings and changes nothing permanent, which is the point:
a one-off run should not have to rewrite your defaults to happen.

## Build

The renderer is built by electron-vite. Tailwind v4 runs through PostCSS, and
the React Compiler is enabled through a Babel plugin in the Vite config. The
compiler is not decoration here: rows re-render on every cursor move, and the
memoization is what stops each block's state and each markdown document from
being re-parsed every time.
