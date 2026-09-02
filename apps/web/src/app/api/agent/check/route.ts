import { z } from "zod";
import { providerUrl } from "@/lib/provider";

const requestBody = z.object({
  endpoint: z.string(),
  apiKey: z.string(),
});

/** A provider's `/models` listing, as far as this check cares. */
const modelsResponse = z.object({
  data: z.array(z.object({ id: z.string() })).optional(),
  error: z.union([z.string(), z.object({ message: z.string() })]).nullish(),
});

/**
 * Answers "do these credentials actually work?" so settings can say so the
 * moment they are typed, instead of leaving the first failure to a confused
 * agent block later.
 *
 * `GET /models` is the probe: every OpenAI-completions provider serves it,
 * it needs the same bearer token a completion does, and it costs nothing.
 * The verdict is always HTTP 200 with an `ok` field — a failed probe is
 * still a successful check, and collapsing the two would make the client
 * handle transport errors twice.
 */
export async function POST(request: Request): Promise<Response> {
  let body: z.infer<typeof requestBody>;
  try {
    body = requestBody.parse(await request.json());
  } catch {
    return Response.json({ ok: false, message: "malformed check request" });
  }

  const url = providerUrl(body.endpoint, "models");
  if (!url) {
    return Response.json({
      ok: false,
      message: "not a valid URL — it needs a scheme and host",
    });
  }
  if (!body.apiKey) {
    return Response.json({ ok: false, message: "no API key set" });
  }

  const upstream = await fetch(url, {
    headers: { authorization: `Bearer ${body.apiKey}` },
  }).catch((error: unknown) => {
    console.error(`provider check: fetch to ${url} failed:`, error);
    return null;
  });

  if (!upstream) {
    return Response.json({ ok: false, message: `cannot reach ${url}` });
  }

  const raw = await upstream.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({
      ok: false,
      message: `HTTP ${upstream.status}: ${raw.slice(0, 120) || "(empty response)"}`,
    });
  }

  const parsed = modelsResponse.safeParse(payload);
  if (!parsed.success) {
    return Response.json({
      ok: false,
      message: `HTTP ${upstream.status}: unexpected response from ${url}`,
    });
  }

  const failure =
    typeof parsed.data.error === "string"
      ? parsed.data.error
      : parsed.data.error?.message;
  if (failure) return Response.json({ ok: false, message: failure });

  if (!upstream.ok) {
    return Response.json({
      ok: false,
      message:
        upstream.status === 401 || upstream.status === 403
          ? `HTTP ${upstream.status} — API key rejected`
          : `HTTP ${upstream.status}`,
    });
  }

  const models = parsed.data.data?.length ?? 0;
  return Response.json({
    ok: true,
    message: models > 0 ? `reachable, ${models} models` : "reachable",
  });
}
