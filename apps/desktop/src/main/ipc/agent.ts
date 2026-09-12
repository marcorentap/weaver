import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AgentEvent, AgentRunRequest } from "../../shared/agent-events.js";
import { agentRunRequest } from "../../shared/agent-events.js";
import type { CheckResult, ProviderUsageResult } from "../../shared/ipc-contract.js";
import { buildAgentRuntime } from "../lib/agent-runtime.js";
import { projectRoot } from "../lib/project.js";
import { providerUrl } from "../lib/provider.js";
import { readRemoteSettings, remoteBaseUrl } from "../lib/remote-settings.js";
import { runAgent } from "../lib/run-agent.js";
import { schemaMessage } from "../lib/schema-error.js";

/** In-flight runs, keyed by `runId`, so `agent:run:cancel` can abort one
 *  without a `Request`/`AbortSignal` to listen on. Entries are removed once
 *  a run reaches `done`/`error` on its own, or once cancelled. A local run
 *  aborts its session; a remote run aborts the HTTP stream. */
const runs = new Map<string, { abort: () => void }>();

/**
 * One agent run, dispatched to wherever the settings say: this machine when
 * the remote connection is off, the configured remote instance when it is
 * on. Both paths speak the same `AgentEvent` stream, so the renderer cannot
 * tell which one it used.
 */
async function handleRun(
  event: IpcMainInvokeEvent,
  runId: string,
  rawRequest: AgentRunRequest,
): Promise<void> {
  const channel = `agent:run:event:${runId}`;
  const emit = (agentEvent: AgentEvent) => {
    // The renderer's channel listener may be gone if it navigated mid-run;
    // a dead renderer must not take the main process down with it.
    if (!event.sender.isDestroyed()) event.sender.send(channel, agentEvent);
  };

  try {
    const remote = readRemoteSettings();
    if (remote.enabled) {
      const base = remoteBaseUrl(remote.url, remote.port);
      if (!base) {
        emit({ type: "error", message: "remote: URL invalid" });
        return;
      }
      if (!remote.key.trim()) {
        emit({ type: "error", message: "remote: no key set" });
        return;
      }
      await runRemote(
        { base, key: remote.key.trim() },
        runId,
        rawRequest,
        emit,
      );
      return;
    }
    await runAgent(
      rawRequest,
      {
        ...buildAgentRuntime(),
        root: projectRoot(),
        onSession: (abort) => runs.set(runId, { abort }),
      },
      emit,
    );
  } finally {
    runs.delete(runId);
  }
}

/** Streams one run to the configured remote instance and re-emits every
 *  event locally, same shape as a local run. Cancelling the run aborts the
 *  HTTP request, which the server treats as session abort. */
async function runRemote(
  remote: { base: string; key: string },
  runId: string,
  rawRequest: unknown,
  emit: (event: AgentEvent) => void,
): Promise<void> {
  // Validated here so a malformed request fails before it is shipped across
  // the network (the server would reject it too, but loudly where the user
  // can fix it is better than a 400 from a machine they cannot see).
  let request: AgentRunRequest;
  try {
    request = agentRunRequest.parse(rawRequest);
  } catch (error) {
    emit({ type: "error", message: schemaMessage(error) });
    return;
  }

  const controller = new AbortController();
  runs.set(runId, { abort: () => controller.abort() });

  try {
    const response = await fetch(`${remote.base}/v1/run`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${remote.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      emit({
        type: "error",
        message:
          response.status === 401 || response.status === 403
            ? "remote rejected the key"
            : `remote: HTTP ${response.status}${body ? `: ${body}` : ""}`,
      });
      return;
    }
    if (!response.body) {
      emit({ type: "error", message: "remote: empty response" });
      return;
    }

    // NDJSON in, `AgentEvent`s out. The stream ends on the server's terminal
    // event, or when the request breaks (server died mid-run), which is
    // exactly what an error event is for.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let parsed: AgentEvent;
        try {
          parsed = JSON.parse(line) as AgentEvent;
        } catch {
          continue;
        }
        emit(parsed);
        if (parsed.type === "done" || parsed.type === "error") {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
    // The body ended without a terminal event: the server went away.
    emit({ type: "error", message: "remote: run ended" });
  } catch (error) {
    if (controller.signal.aborted) return; // cancelled by the operator
    emit({
      type: "error",
      message: `remote unreachable: ${error instanceof Error ? error.message : String(error)}`,
    });
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
}