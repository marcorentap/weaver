# The desktop shell

The main process owns everything the renderer cannot: the database, the
provider requests, the filesystem, subprocesses, and the protocol that serves
media bytes. This document covers how the app starts, what crosses the IPC
boundary, and the pieces of main that exist for a runner to call.

## Starting up

`apps/desktop/src/main/index.ts` is the entry. A few things happen at module
load, because Electron only honours them there:

- `app.setName("Weaver")` and `app.setDesktopName("weaver.desktop")`. The
  desktop name has to match the installed `.desktop` filename or taskbar
  grouping breaks.
- `protocol.registerSchemesAsPrivileged` for `weaver-media`. Privileges are only
  read for schemes declared before the app is ready.

The application menu is rebuilt role for role, minus reload and force reload.
Electron's default binds Ctrl+R to reload, and the chat page wants that key for
redo. Swallowing it in `before-input-event` cannot fix this, because the
`preventDefault` there also eats the page's own keydown, so the item is removed
instead.

`before-input-event` is used for something else: keys main has to take before
the page sees them. `SWALLOWED_KEYS` in `shared/keys.ts` is that list (today
just `ctrl+w`, the pane-splitting leader), and only the first press of a held
key is forwarded over `keymap:chord-leader`.

One window, 1280 by 800, `contextIsolation: true`, `sandbox: false`,
`nodeIntegration: false`, preload from `../preload/index.mjs`. In development it
loads `ELECTRON_RENDERER_URL`; otherwise it loads the built HTML file. External
links are denied and opened in the system browser, since everything else a run
touches already lives inside the operator's own project and store.

The order inside `whenReady` matters:

```
registerMediaProtocol()
ensurePluginsLoaded()        plugins first, so store writes validate against every kind
registerChatHandlers()
registerAgentHandlers()
registerSettingsHandlers()
registerPluginHandlers()
registerHindsightHandlers()
registerLinkHandlers()
installApplicationMenu()
createWindow()
```

There is no single instance lock.

## The IPC surface

Every group is defined once in `shared/ipc-contract.ts`, exposed by
`preload/index.ts` as `window.api`, and handled by one file per domain in
`main/ipc/`. All of it is `ipcMain.handle`; the only streaming path in the whole
app is the per-run event channel.

| Group       | Methods                                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat`      | `loadGraph`, `saveGraph`, `createChatBlock`, `createChatSession`, `renameChatSession`, `duplicateChatSession`, `deleteChatSession`, `updateBlockField`, `updateBlockLabel`, `moveChatBlock`, `deleteChatBlock` |
| `agent`     | `check`, `providerUsage`, `run:start`, `run:cancel`, `run:answer`                                                                                                                                              |
| `settings`  | `get`, `set`                                                                                                                                                                                                   |
| `plugins`   | `list`, `validate`                                                                                                                                                                                             |
| `links`     | `types`, `search`, `materials`                                                                                                                                                                                 |
| `hindsight` | `retain`                                                                                                                                                                                                       |

Settings are opaque key and value rows. There is no allowlist and no validation;
the shape of a setting is the business of whoever reads it.

The `chat` mutations all run through `rewrite(graphId, apply)`, which loads the
whole graph, applies one pure tree operation from `@repo/core`, and writes it
back. Errors come back as `{ error: schemaMessage(...) }` rather than as a
rejection, so the renderer can show which field was wrong.

`agent:check` probes the endpoint's model listing, which is how the app knows
what a provider offers, and `agent:providerUsage` reads OpenRouter's key
endpoint so its usage panel has something real in it.

## Storage

The store is `packages/store`, SQLite through `node:sqlite`, at
`$WEAVER_STORE` or `~/.weaver/store.db`.

```sql
graph(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
      modified_at INTEGER NOT NULL)

block(id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL REFERENCES graph(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, label TEXT NOT NULL,
      created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL,
      next_id TEXT, children_id TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      hidden INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1)

setting(key TEXT PRIMARY KEY, value TEXT NOT NULL)
```

One row per block, and the tree is two nullable self-references, `next_id` and
`children_id`. Neither is a foreign key, so a write is a set of rows pointing at
each other. `kind` has no check constraint, since kinds are open.

Writes are whole-graph. `writeGraph` deletes the rows the input no longer has,
upserts the rest, touches the graph's `modified_at`, all inside one
`BEGIN IMMEDIATE` transaction, and before committing runs `assertTree` and, when
the kinds were supplied, `assertValidData`. A malformed block never reaches
disk, which is why nothing downstream has to defend against one.

Reads are validated with zod. The schema version lives in `PRAGMA user_version`,
currently 6. An older database is migrated forward one step at a time, each step
an entry in a table keyed by the version it reaches; a version below the current
one with no step to it, or a database newer than this build, is an error rather
than a guess, so a version is never stamped on a database that did not really
reach it.

`main/lib/store.ts` is a thin wrapper that opens the store once for the app's
lifetime, with the loaded plugin kinds. On an empty store it writes a seed graph:
an onboarding document built from `text`, `group` and `media` blocks that
explains the graph by being one. Separately, every new chat session starts with a
single `environment` block setting `WEAVER_PWD` to the process's working
directory, so a fresh session has a project without anything being written.

## `weaver-media://`

The renderer cannot read a file, and media bytes never cross IPC. Instead main
registers a privileged `weaver-media://` scheme and serves them, which keeps the
allowlisting and the byte-serving in one place.

A request is
`weaver-media://local/<encodeURIComponent(uri)>`, built by `mediaProtocolUrl`.
There is no path traversal to worry about, because the payload is an encoded URI
rather than a path.

`handleMediaRequest` allows a request when any of these holds: some stored
`media` block references that URI, the URI is in the project, or the URI is
pending. Local files are streamed with byte-range support and `no-store` caching.
Remote URLs proxy only text, since anything else a browser can load directly.
Everything else is a 403.

Pending media is the window between a block being produced and it being
persisted. A run that is about to show a picture registers the URI before the
renderer asks for it, which covers the moment before autosave writes the
reference. `run-agent.ts` registers URIs from `display_media` and from any
inline `![...](file://...)` markdown image the model writes itself, since
without that an image written inline would 403 and silently fail to render.

## Agent resources

Discovery is defined in `main/lib/agent-dir.ts`. There are three roots, and their
order is their precedence:

```
<cwd>/.weaver/<type>
<cwd>/.agents/<type>
~/.agents/<type>
```

for the resource types `skills`, `prompts`, `themes` and `extensions`. pi's own
directories are never consulted, and pi's project-local settings file is never
opened: weaver hands the loader every directory explicitly, with pi's discovery
passes turned off (`projectTrusted: false`). Context files are `AGENTS.md`.

`main/lib/agent-resources.ts` builds the settings manager and the resource
loader. `main/lib/run-agent.ts` reads `main/agent/system-prompt.md` and passes it
as the loader's system prompt, replacing pi's default outright.

`PI_CODING_AGENT_DIR` is defaulted to `~/.agents` so that a pi code path
somewhere does not fall back to its own directory.

## Links

A user message may attach a reference inline as `@<type>:<value>`. The syntax is
`shared/references.ts`; the providers are `main/lib/links/`.

Two types ship: `file` and `skill`. `LINK_PROVIDERS` in `links/registry.ts` is
the list, and its order is the menu order. The file provider walks the project
root one level deep, skipping build and dependency directories, and ranks
candidates with the shared fuzzy matcher. The skill provider lists exactly the
skills a run would load, using the same roots as the resource loader, so what
you can complete and what a run discovers cannot drift apart.

The completion root is not the app's working directory. `WEAVER_PWD` is resolved
for the block being edited, through the same merged-environment walk a run
there would use, and it is passed along with the search. `renderer/src/lib/env.ts`
does that on the renderer side, `weaverRoot(pwd)` in `main/lib/project.ts` does it
on main's side, and the media protocol falls back to the same helper. Completion,
media and inference therefore agree about the project.

References are not sent with the run. `links/material.ts` resolves each one in
main, a skill in full and a file through the same bounded, symbol-indexed read
the `read` tool gives, and the renderer writes each one into the graph as a
`text` block just above the message. The message's own run, and every run after
it, then reads the material as ordinary blocks above its turn.

## File tools

`read`, `write` and `edit` replace the SDK's tools of the same name so that
`path` may also be a URI. `main/lib/file-target.ts` resolves one into either a
local path or an `ssh://` target, rejecting `http(s)://` for writes since writing
to an arbitrary URL has no general meaning. `ssh` shells out to the ssh binary.

The `read` tool is the one with a point of view. Reads are capped at about 4KB.
A whole-file read of a code file returns a tree-sitter symbol index, one line per
top-level declaration with its line number, because a 900 line file read as text
costs a fortune in context and says nothing. Any other whole-file read returns
the first page, marked truncated. Directories list their entries. Line mode and
byte mode are mutually exclusive, and the byte mode exists for the one huge line
a minified file or a single JSON blob turns out to be.

Indexing is `main/lib/symbol-index.ts`, using `web-tree-sitter` with grammars
loaded as wasm from next to the bundled main process. It never throws: any
failure falls back to the bounded read.

## Environment variables

| Variable               | Read by    | Meaning                                                                      |
| ---------------------- | ---------- | ---------------------------------------------------------------------------- |
| `WEAVER_PWD`           | weaver     | project directory for a run; relative paths resolve against the project root |
| `WEAVER_STORE`         | store      | SQLite path, default `~/.weaver/store.db`                                    |
| `PI_CODING_AGENT_DIR`  | agent dir  | agent directory, default `~/.agents`                                         |
| `WEAVER_SYSTEM_PROMPT` | run engine | replaces the default system prompt                                           |
