import type { AgentEvent, AgentRunRequest } from "@shared/agent-events.js";

/**
 * Streams one inference run's events to `onEvent`, in the order the main
 * process emits them — the direct replacement for the old
 * `fetch("/api/agent/run")` + hand-parsed NDJSON stream. `window.api.agent.run`
 * (see the preload bridge) already does the IPC plumbing and hands back
 * parsed `AgentEvent`s one at a time, so this is now a thin wrapper that only
 * turns its callback shape into the `Promise<void>` shape `runInference` in
 * `lib/live-graph.ts` awaits.
 *
 * Behavior change from the old fetch-based version: there is no longer a
 * separate "request rejected outright, before any event arrived" phase to
 * `throw` for — `agent:run:start` is fire-and-forget over IPC, so every
 * failure, pre-flight or mid-stream, now arrives as an `error` event to
 * `onEvent` instead. This promise simply resolves once a terminal event
 * (`done` or `error`) has been delivered and never rejects, which is a strict
 * simplification of the original's split try/catch: both `done` and `error`
 * were already treated as terminal there, just reached via two different
 * code paths (a resolved await vs. a `failure` variable checked after it).
 */
export function streamInference(
  request: AgentRunRequest,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  // `Promise.withResolvers` would read cleaner here, but this project's
  // shared tsconfig pins `lib` to `es2022`, which predates it.
  return new Promise((resolve) => {
    window.api.agent.run(request, (event) => {
      onEvent(event);
      if (event.type === "done" || event.type === "error") resolve();
    });
  });
}
