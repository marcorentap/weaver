import type { AgentEvent, AgentRunRequest } from "@shared/agent-events.js";

/**
 * Streams one inference run's events to `onEvent`, in the order the main
 * process emits them. The direct replacement for the old
 * `fetch("/api/agent/run")` + hand-parsed NDJSON stream. `window.api.agent.run`
 * (see the preload bridge) already does the IPC plumbing and hands back
 * parsed `AgentEvent`s one at a time. This wrapper only turns that callback
 * shape into the `Promise<void>` shape `runInference` in `lib/live-graph.ts`
 * awaits.
 *
 * This is a behavior change from the old fetch-based version. There is no
 * longer a separate "request rejected outright, before any event arrived"
 * phase to `throw` for. `agent:run:start` is fire-and-forget over IPC, so
 * every failure, pre-flight or mid-stream, arrives as an `error` event to
 * `onEvent` instead. The promise resolves once a terminal event (`done` or
 * `error`) has been delivered and never rejects. That is a strict
 * simplification of the original's split try/catch, which already treated
 * `done` and `error` as terminal through a resolved await or a `failure`
 * variable checked after it.
 */
export function streamInference(
  request: AgentRunRequest,
  onEvent: (event: AgentEvent) => void,
): { done: Promise<void>; cancel: () => void } {
  // `Promise.withResolvers` would read cleaner here, but this project's
  // shared tsconfig pins `lib` to `es2022`, which predates it.
  let finish: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runCancel = window.api.agent.run(request, (event) => {
    onEvent(event);
    if (event.type === "done" || event.type === "error") finish();
  });
  // The preload's cancel unsubscribes its own IPC listener, so the main
  // process's terminal event never reaches `onEvent` after an abort. Resolve
  // the promise ourselves, or the engine would keep the run flagged forever.
  const cancel = () => {
    runCancel();
    finish();
  };
  return { done, cancel };
}
