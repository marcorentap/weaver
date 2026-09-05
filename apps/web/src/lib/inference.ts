import { z } from "zod";
import { agentEvent, type AgentEvent } from "./agent-events";

/** How a run's failure comes back when the route rejects it outright, before
 *  the event stream starts. */
const runRejection = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]).nullish(),
});

/** Request body of `/api/agent/run` — the same shape whatever block asked
 *  for a run, since the route has no idea what kind that block is. */
export type InferenceRequest = {
  endpoint: string;
  apiKey: string;
  model: string;
  /** The graph above the block that asked for this run, already flattened —
   *  the route has no view of the live graph, which lives in the browser. */
  context: string;
  /** The asking block's own content — the last turn before the reply. */
  prompt: string;
  /** Built-in tool names to enable for this run. Empty means read-only. */
  tools: string[];
};

/**
 * Streams one inference run's events to `onEvent`, in the order the server
 * emits them. Throws only for a request rejected outright, before any event
 * arrives — a failure mid-stream instead arrives as an `error` event, so the
 * caller can render it like any other output instead of losing whatever
 * already streamed in.
 */
export async function streamInference(
  request: InferenceRequest,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const res = await fetch("/api/agent/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok || !res.body) {
    const raw = await res.text();
    const rejection = runRejection.safeParse(
      ((): unknown => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })(),
    );
    const message = rejection.success
      ? typeof rejection.data.error === "string"
        ? rejection.data.error
        : rejection.data.error?.message
      : undefined;
    throw new Error(
      message ?? `HTTP ${res.status}: ${raw.slice(0, 200) || "(empty)"}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  const handle = (line: string) => {
    const parsed = agentEvent.safeParse(JSON.parse(line));
    if (!parsed.success) return; // A step this build does not know.
    onEvent(parsed.data);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    // Events are newline-delimited, and a chunk boundary lands anywhere: the
    // tail is kept until its newline shows up.
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) handle(line);
    }
  }
  if (buffered.trim()) handle(buffered);
}
