import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AgentEvent, AgentRunRequest } from "../../shared/agent-events.js";
import type { CheckResult, ProviderUsageResult } from "../../shared/ipc-contract.js";
import { buildAgentRuntime } from "../lib/agent-runtime.js";
import { projectRoot } from "../lib/project.js";
import { providerUrl } from "../lib/provider.js";
import { runAgent } from "../lib/run-agent.js";

/** In-flight runs, keyed by `runId`, so `agent:run:cancel` can abort one
 *  without a `Request`/`AbortSignal` to listen on. Entries are removed once
 *  a run reaches `done`/`error` on its own, or once cancelled. Aborting the
 *  run aborts its session. `answer` is how a run parked on a question is
 *  released. */
const runs = new Map<
  string,
  {
    abort: () => void;
    answer?: (id: string, value: string | null) => void;
  }
>();

/**
 * One agent run, on this machine, streamed to the renderer as the same
 * `AgentEvent` shape a run has always spoken.
 */
async function handleRun(
  event: IpcMainInvokeEvent,
  runId: string,
  rawRequest: AgentRunRequest,
): Promise<void> {
  const channel = `agent:run:event:${runId}`;
  /** The questions this run has raised and is parked on: the wire id of each
   *  `wait` event, mapped to the resolver its tool call is sitting on. */
  const waits = new Map<string, (value: string | null) => void>();
  /**
   * Release every unanswered question with no answer. Anything that ends a
   * run out from under a waiting tool call — a cancel, a renderer that went
   * away — has to do this, because the agent's loop is parked inside that
   * call: a promise nobody settles never lets the run finish, and never lets
   * the session be disposed. Null is the honest value here; no user is left
   * to answer.
   */
  const settleWaits = () => {
    for (const resolve of waits.values()) resolve(null);
    waits.clear();
  };
  const emit = (agentEvent: AgentEvent) => {
    // The renderer's channel listener may be gone if it navigated mid-run;
    // a dead renderer must not take the main process down with it. Nor may
    // it leave a question hanging: with nobody left to answer, the run is
    // released as unanswered and allowed to finish on its own.
    if (event.sender.isDestroyed()) {
      settleWaits();
      return;
    }
    event.sender.send(channel, agentEvent);
  };

  try {
    await runAgent(
      rawRequest,
      {
        ...buildAgentRuntime(),
        root: projectRoot(),
        // Park a tool call until the user answers the block it raised. The
        // promise is set up before the `wait` event is emitted (see
        // `runAgent`), so an answer that comes back fast cannot arrive
        // before there is somewhere to put it.
        wait: (id) =>
          new Promise<string | null>((resolve) => waits.set(id, resolve)),
        onSession: (abort) =>
          runs.set(runId, {
            abort: () => {
              settleWaits();
              abort();
            },
            answer: (id, value) => {
              const resolve = waits.get(id);
              if (!resolve) return;
              waits.delete(id);
              resolve(value);
            },
          }),
      },
      emit,
    );
  } finally {
    settleWaits();
    runs.delete(runId);
  }
}

const checkRequestBody = z.object({
  endpoint: z.string(),
  apiKey: z.string(),
});

/** A provider's `/models` listing, as far as this check cares. */
const modelsResponse = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        supported_parameters: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  error: z.union([z.string(), z.object({ message: z.string() })]).nullish(),
});

/**
 * Answers "do these credentials actually work?" so settings can say so the
 * moment they are typed, instead of leaving the first failure to surface
 * during an agent run.
 *
 * `GET /models` is the probe: every OpenAI-completions provider serves it,
 * it needs the same bearer token a completion does, and it costs nothing.
 * The verdict is always `{ ok, message }`. A failed probe is still a
 * successful check, and collapsing the two would make the caller handle
 * transport errors twice.
 */
async function checkAgent(endpoint: string, apiKey: string): Promise<CheckResult> {
  let body: z.infer<typeof checkRequestBody>;
  try {
    body = checkRequestBody.parse({ endpoint, apiKey });
  } catch {
    return { ok: false, message: "malformed check request" };
  }

  const url = providerUrl(body.endpoint, "models");
  if (!url) {
    return {
      ok: false,
      message: "not a valid URL. It needs a scheme and host",
    };
  }
  if (!body.apiKey) {
    return { ok: false, message: "no API key set" };
  }

  const upstream = await fetch(url, {
    headers: { authorization: `Bearer ${body.apiKey}` },
  }).catch((error: unknown) => {
    console.error(`provider check: fetch to ${url} failed:`, error);
    return null;
  });

  if (!upstream) {
    return { ok: false, message: `cannot reach ${url}` };
  }

  const raw = await upstream.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: `HTTP ${upstream.status}: ${raw || "(empty response)"}`,
    };
  }

  const parsed = modelsResponse.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      message: `HTTP ${upstream.status}: unexpected response from ${url}: ${raw}`,
    };
  }

  const failure =
    typeof parsed.data.error === "string"
      ? parsed.data.error
      : parsed.data.error?.message;
  if (failure) return { ok: false, message: failure };

  if (!upstream.ok) {
    return {
      ok: false,
      message:
        upstream.status === 401 || upstream.status === 403
          ? `HTTP ${upstream.status}. API key rejected`
          : `HTTP ${upstream.status}`,
    };
  }

  const models = parsed.data.data ?? [];
  const modelIds = models.map((model) => model.id);
  const modelParameters = Object.fromEntries(
    models
      .filter((model) => model.supported_parameters)
      .map((model) => [model.id, model.supported_parameters!]),
  );
  return {
    ok: true,
    message:
      modelIds.length > 0
        ? `reachable, ${modelIds.length} models`
        : "reachable",
    models: modelIds,
    modelParameters,
  };
}

/** OpenRouter's `GET /key` response, as far as the settings usage panel
 *  cares. See https://openrouter.ai/docs/api_reference/limits. */
const keyResponse = z.object({
  data: z.object({
    label: z.string(),
    limit: z.number().nullable(),
    limit_remaining: z.number().nullable(),
    usage: z.number(),
    usage_daily: z.number(),
    usage_weekly: z.number(),
    usage_monthly: z.number(),
    is_free_tier: z.boolean(),
  }),
});

/**
 * OpenRouter's key-scoped credit limit and how much of it is spent today,
 * this week, this month, and all time. Same probe shape as `checkAgent`,
 * against `GET /key` instead of `GET /models`. There is no equivalent
 * endpoint for other providers, so this always targets OpenRouter and does
 * not try to detect a provider from `endpoint` itself.
 */
async function checkProviderUsage(
  endpoint: string,
  apiKey: string,
): Promise<ProviderUsageResult> {
  const url = providerUrl(endpoint, "key");
  if (!url) {
    return { ok: false, message: "not a valid URL. It needs a scheme and host" };
  }
  if (!apiKey) return { ok: false, message: "no API key set" };

  const upstream = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  }).catch((error: unknown) => {
    console.error(`provider usage: fetch to ${url} failed:`, error);
    return null;
  });
  if (!upstream) return { ok: false, message: `cannot reach ${url}` };

  const raw = await upstream.text();
  if (!upstream.ok) {
    return {
      ok: false,
      message:
        upstream.status === 401 || upstream.status === 403
          ? `HTTP ${upstream.status}. API key rejected`
          : `HTTP ${upstream.status}: ${raw || "(empty response)"}`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: `HTTP ${upstream.status}: unexpected response from ${url}: ${raw}`,
    };
  }
  const parsed = keyResponse.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, message: `unexpected response shape from ${url}: ${raw}` };
  }
  const data = parsed.data.data;
  return {
    ok: true,
    message: "reachable",
    usage: {
      label: data.label,
      limit: data.limit,
      limitRemaining: data.limit_remaining,
      usage: data.usage,
      usageDaily: data.usage_daily,
      usageWeekly: data.usage_weekly,
      usageMonthly: data.usage_monthly,
      isFreeTier: data.is_free_tier,
    },
  };
}

export function registerAgentHandlers(): void {
  ipcMain.handle("agent:check", (_event, endpoint: string, apiKey: string) =>
    checkAgent(endpoint, apiKey),
  );
  ipcMain.handle(
    "agent:providerUsage",
    (_event, endpoint: string, apiKey: string) =>
      checkProviderUsage(endpoint, apiKey),
  );
  ipcMain.handle(
    "agent:run:start",
    (event, runId: string, request: AgentRunRequest) =>
      handleRun(event, runId, request),
  );
  ipcMain.handle("agent:run:cancel", (_event, runId: string) => {
    runs.get(runId)?.abort();
    runs.delete(runId);
  });
  ipcMain.handle(
    "agent:run:answer",
    (_event, runId: string, id: string, value: string | null) => {
      runs.get(runId)?.answer?.(id, value);
    },
  );
}