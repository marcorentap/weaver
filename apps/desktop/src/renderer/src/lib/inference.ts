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
 *
 * `answer` is the other half of a run that asked something: it settles the
 * tool call parked behind a `wait` event, so the same stream — which keeps
 * emitting into `onEvent` — carries on from the answer. Both it and `cancel`
 * are the bridge's own handle to this one run, so neither can be aimed at
 * another run happening at the same time.
 */
export function streamInference(
  request: AgentRunRequest,
  onEvent: (event: AgentEvent) => void,
): {
  done: Promise<void>;
  cancel: () => void;
  answer: (id: string, value: string | null) => void;
} {
  // `Promise.withResolvers` would read cleaner here, but this project's
  // shared tsconfig pins `lib` to `es2022`, which predates it.
  let finish: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const run = window.api.agent.run(request, (event) => {
    onEvent(event);
    if (event.type === "done" || event.type === "error") finish();
  });
  // The preload's cancel unsubscribes its own IPC listener, so the main
  // process's terminal event never reaches `onEvent` after an abort. Resolve
  // the promise ourselves, or the engine would keep the run flagged forever.
  const cancel = () => {
    run.cancel();
    finish();
  };
  // Fire-and-forget, like the run itself: the answer travels by IPC and the
  // run's own events say what became of it, so there is nothing here to
  // await. A run that already ended simply has nowhere to put it.
  const answer = (id: string, value: string | null) => {
    void run.answer(id, value);
  };
  return { done, cancel, answer };
}
