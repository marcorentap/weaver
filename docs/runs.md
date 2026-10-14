# Runs

A run is one inference. It is anchored at a block, sees the graph above that
block, and appends what it produces back into the graph just after it. This
document follows one from the keypress to the blocks it leaves behind.

## What a run is anchored on

Any block can anchor a run. Pressing `x` on a row starts one from that block;
pressing `s` starts a summarization of an explicit set of blocks instead. A run
is one-way: it reads the graph above it and writes below it, never sideways.

## The renderer builds the request

`runAgentText` in `renderer/src/lib/live-graph.ts` is where a keypress becomes a
request. It calls into `@repo/core` for the material:

```
messagesAbove(graph, id, kinds)        the graph above, turn by turn
messagesOfBlock(graph, id, kinds)      the anchor's own turns
mergedEnvironment(graph, id)           the environment blocks above it
block.images                           pictures the anchor holds
```

The last `user` turn of the anchor becomes `prompt`, the rest of the anchor's
turns are spliced in ahead of it on the main side, and the merged environment
becomes `env`. Everything else comes from the run connection: endpoint, key,
model, provider id, thinking level, token cap, which tools to enable, and the
five resource discovery flags. The request body is
`AgentRunRequest` in `shared/agent-events.ts`, validated by zod on arrival in
main like every other IPC payload.

`streamInference` in `renderer/src/lib/inference.ts` is the transport. It calls
`window.api.agent.run(request, onEvent)`. The preload bridge mints a `runId`,
subscribes to `agent:run:event:<runId>`, invokes `agent:run:start`, and returns
`{ cancel, answer }`; the bridge unsubscribes itself on the terminal event, and
`streamInference` wraps that into a `done` promise. `done` resolves on the
terminal `done` or `error` and never rejects; a pre-flight failure arrives as an
`error` event instead.

The run protocol is these four channels, named in the same place, so they are
worth listing together:

| Channel                   | Direction        | Purpose                            |
| ------------------------- | ---------------- | ---------------------------------- |
| `agent:run:start`         | invoke           | the request                        |
| `agent:run:event:<runId>` | main to renderer | one `AgentEvent` per message       |
| `agent:run:cancel`        | invoke           | abort one run                      |
| `agent:run:answer`        | invoke           | release a run parked on a question |

## Events become blocks

`AgentEvent` is a discriminated union in `shared/agent-events.ts`, validated on
both sides. The renderer turns each one into a block as it arrives:

| Event                              | Block it lands in                                |
| ---------------------------------- | ------------------------------------------------ |
| `thinking_delta`, `thinking`       | a hidden `text` block labelled "thinking"        |
| `text_delta`, `text`               | the run's `assistant` block                      |
| `tool_start`, `tool_delta`, `tool` | one `tool` block per wire id                     |
| `block`                            | a block of the named kind, after its data parses |
| `wait`                             | the question block the run stopped on            |
| `nest`, `unnest`                   | scopes the blocks in between under a tool call   |
| `error`                            | a `text` block labelled "error"                  |
| `done`                             | nothing; the run is over                         |

Deltas append into a block that is already there, and the closing `text` or
`tool` event carries the authoritative full content. A provider that never
streams still works, because the full event arrives either way.

## The run holds its own tail

Two pieces of bookkeeping live on the engine rather than in a component, so a
tab switch cannot lose them.

`appendTails` maps an anchor to the last block the run appended. The next block
goes after that, not after the anchor. Walking `next` to find it would run off
the end of the whole chain, and the block the run is parked on is editable and
deletable, so the tail is repaired when that block is removed.

`lockedBlockIds(graph, appendTails, waiting)` is the lock. It is every block from
the anchor's `next` up to the run's tail, plus every descendant of those, since
a subagent transcript hangs under its tool block. A locked block refuses every
mutation, because a run is appending into that region and an edit underneath it
would land the next block somewhere the run did not expect.

Waiting blocks are exempt from the lock. Answering a question _is_ an edit to
the run's own output, so the one thing the lock must not stop is the thing that
lets the run continue.

## Parked runs

A tool can ask a question it cannot answer itself. `ctx.wait(kind, data, label)`
materializes a block and leaves the agent loop parked inside its own tool call.

The ordering is careful. Main registers the promise for the wire id before it
emits the `wait` event, so an answer that comes back quickly cannot outrun the
promise it belongs to. The renderer materializes the block, keeps it in
`pendingWaits`, and watches it.

The run resumes when the block's kind answers `resume(state)` with something
other than null. The renderer then calls `agent:run:answer` with that text, main
resolves the parked promise, and the tool call finishes with the answer as its
own result. The model continues from having been answered rather than from
having asked.

A kind with no `resume` is refused before a block lands at all: `runAgent` checks
for the hook and returns null, so the tool hears "nobody answered" and says so,
instead of the run hanging on a form nothing can submit.

Nothing may leave a run parked forever. A cancel, a deleted question, or a
renderer that went away all settle the pending waits with null.

## Cancelling

`abortRun` calls the abort the engine stored when the run started, which is
`streamInference`'s cancel, which invokes `agent:run:cancel`. Main looks the run
up by id and aborts its pi session. The renderer then clears any pending waits
belonging to that run and stops showing it as running.

## The main side

`main/ipc/agent.ts` handles the invoke and calls `runAgent(request, ctx, emit)`
in `main/lib/run-agent.ts`. `ctx` is built by `buildAgentRuntime`: the kind
registry, the plugin tools, a `getSetting` that reads plugin settings out of the
store, and `registerPendingMedia`. The IPC handler adds `root` (the project
root) and `onSession`, which is how a run becomes cancellable.

`runAgent` then does the same things in the same order for every run.

**A model runtime with nothing on disk.** `ModelRuntime.create` is given an
`InMemoryCredentialStore`, no `modelsPath`, and `allowModelNetwork: false`. The
endpoint and key arrive with the request and are never written down, which also
keeps pi's default file-backed auth path out of the process. A `weaver` provider
is registered over the request's endpoint speaking `openai-completions`, with
exactly the one model named in the request. Provider-specific request tuning
(reasoning fields, sampling parameters, compatibility flags) is computed by
`providerTuning` from the provider id and settings.

**A vision probe, asked lazily.** `modelTakesImages(endpoint, apiKey, model)` in
`main/lib/model-vision.ts` asks the endpoint's `/models` listing and falls back
on pi's bundled catalog. It is called once per run and only if some turn already
carries a picture, since a run with no picture in it never needs to know. The
answer decides whether images go out and what the registered model claims to
accept.

**A working directory.** `WEAVER_PWD` from the request's merged environment wins
if it is absolute, resolves against the project root if it is relative, and
falls back to the project root if there is none. This is the same resolution the
`@file:` link provider and the media protocol use, which is why completion,
media and inference agree about the project.

Then the two paths diverge.

### A plain run

`plain: true` skips the agent machinery entirely: no session, no tools, no
system prompt, no resource loading, no environment shading. The request's
context goes through `weaveContext` and is followed by the prompt as the run's
one `user` turn. Summarization runs are plain unless the agentic toggle is on,
which keeps the harness away from a read-compress-reply task when that is what
was asked for. The events are the same shape, so the renderer's plumbing does
not care which kind of run it is watching.

### An agent run

The agent path mounts tools, loads resources and creates a session.

The tool set is the harness's own four plus whatever the plugins contribute. The
model-visible names are `read`, `write`, `edit` and `display_media`, which
replace the SDK's tools of the same name so that `path` may be a `file:`,
`http(s):` or `ssh:` URI as well as a filesystem path. Every tool is on by
default; a block may pick a subset from the union the run computes at mount
time, of `ALLOWED_TOOLS` in `shared/agent-events.ts` (the harness's own tools)
and the names the loaded plugins contribute through `ctx.pluginTools`. A
plugin's tool is therefore offered to the model without any core list naming it,
which is what lets a drop-in plugin add a tool that actually reaches a run.
`display_media` is mounted on every agent run whether a block names it or not,
because a run has to be able to show a picture without the operator thinking to
enable a tool first. This is a single-operator harness, so `bash` and `write`
are not held back from the model.

`display_media` is deliberately narrow. It turns a URI into a media block and
nothing else. An earlier generic version let the model name any kind and fill in
that kind's own fields as JSON, and it kept getting them wrong. There is no
schema left to get wrong when the only fields are a URI and a label.

Resource loading is `createAgentResourceLoader` in
`main/lib/agent-resources.ts`, with pi's own discovery passes turned off and
every directory handed over explicitly. The system prompt is
`main/agent/system-prompt.md`, read at run time through `WEAVER_SYSTEM_PROMPT`,
replacing the SDK's default prompt wholesale. It describes a run as an agent
inside a context document: instructions are the message being answered, anything
above it is context an earlier turn produced, and anything that opted out of
context is not there at all.

The session itself is `createAgentSession` with an in-memory `SessionManager`,
so pi never writes a transcript anywhere. Two hooks make weaver's context reach
the wire:

`session.agent.onPayload` is composed with whatever an extension already put
there, and hands the payload to `spliceContext`, which puts the run's turns in
front of pi's own first turn. This is the only place weaver can speak on an
agent run, since the session issues turns itself with its own timeouts and
retries. pi already uses this hook to let extensions inspect a request, so
composing with it keeps that working.

The session subscription maps pi's events onto `AgentEvent`. It is worth
knowing two details in there. Tool arguments arrive with the call and the result
with its end, so they are paired by the SDK's `toolCallId`, and each entry also
carries the wire id the renderer knows the block by. And streaming tool output
arrives as a full snapshot on every update, so only the growth is shipped as
`tool_delta`.

The run's environment shades `process.env` for the duration of `session.prompt`
and puts back the exact previous values afterwards, because the agent's own
tools spawn shells that inherit it.

**Terminal events wait for the retries.** A turn that ends with an error is not
necessarily the end of the run. pi retries rate limits and server faults with
its own backoff and continues the loop. So a failed turn is recorded rather than
reported, and the one terminal `error` or `done` is emitted only after
`session.prompt` has come back, when the session has really settled. Emitting
it earlier used to show the run as finished while it kept working in the
background.

## Subagents

A tool that calls `ctx.spawnAgent(messages)` starts a nested run inside its own
call. The nested run inherits the spawning request entirely, endpoint, model,
provider tuning, tool list, discovery flags and merged environment, with two
things replaced: its context is the messages the tool passed, and its prompt is
a closing user turn those instructions are answered from. Because the same tool
is mounted on the run it starts, spawning recurses.

The nested run streams into the same channel wrapped in `nest` and `unnest`, and
every id it names is prefixed with the spawning tool call's wire id, so a nested
tool call or question cannot be mistaken for the outer run's. The renderer
appends the whole nested transcript as children of the tool call's block.

The parent never sees any of it. A tool block snapshots only its own call and
output, and the message walks never descend into children, so what reaches the
parent model is the subagent's final answer as the tool result, and later that
one line inside the tool block's snapshot. Nothing of the subagent's reasoning,
its tool calls, or the messages it was handed gets there. The subagent sees only
the messages it was given, not the graph above the spawning block.

Both sides are told the answer is one-way. The tool's description tells a
spawner to require a final answer that stands on its own, and
`SUBAGENT_ANSWER_NOTE` says the same to the subagent in its own context, so the
contract holds even when a run's instruction forgets it.

Deciding what the answer is takes one piece of care. The answer is the
subagent's last assistant message, and an earlier one is dropped the moment the
run does anything after it, because text followed by a tool call was working,
not an answer. Without that a run which ended without a closing message would
hand its parent a mid-run "I'll look into it" as though it were the result.

## Summarization and titles

`summarize` runs the same engine with an explicit set of blocks as its whole
context and a summarization prompt, and the result lands in a `text` block
labelled "summary".

`generateTitle` is a separate read-only path: the whole visible graph as one
`developer` message, a title prompt, a 24 token cap, thinking off, plain mode on.
It writes nothing and returns a string or null.

## Pictures

Pictures travel as URIs, never bytes, because the renderer has no filesystem.
Main reads the file, and `main/lib/context-wire.ts` decides how it goes on the
wire. A `user` turn carries its pictures inline as `image_url` parts; a
`developer` turn gets a following `user` turn led by a line saying these are
attached images from the context above. When the model does not take images the
`images` field is stripped entirely, and the text description the block already
wrote is all that is left.

The `read` tool answers a picture the same way: as an image content part when
the model takes one, as a line naming the file when it does not, and never as a
file's bytes read as text.
