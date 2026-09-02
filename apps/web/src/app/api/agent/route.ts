import { z } from "zod";
import { schemaMessage } from "@/lib/schema-error";
import { providerUrl } from "@/lib/provider";

const message = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const requestBody = z.object({
  /** Provider base URL, e.g. "http://seer:4000/v1" — `/chat/completions` is
   *  appended here. */
  endpoint: z.string().min(1),
  apiKey: z.string(),
  model: z.string().min(1),
  messages: z.array(message).min(1),
});

/** Every failure this route generates itself wears the same shape a provider
 *  uses, so one client-side branch reads them all. */
function failure(message: string, status: number): Response {
  return Response.json({ error: { message } }, { status });
}

/**
 * Proxies one OpenAI-completions `/chat/completions` call to a provider
 * endpoint an agent block names at run time.
 *
 * Kept server-side for two reasons: the API key never appears in the page's
 * own outgoing request, and the endpoint need not be reachable from the
 * browser at all — an internal host like `seer` usually is not, but this
 * server is on the same network it is.
 */
export async function POST(request: Request): Promise<Response> {
  let body: z.infer<typeof requestBody>;
  try {
    body = requestBody.parse(await request.json());
  } catch (error) {
    return failure(schemaMessage(error), 400);
  }

  const url = providerUrl(body.endpoint, "chat/completions");
  if (!url) {
    return failure(
      `"${body.endpoint}" is not a valid provider URL — it needs a scheme and host, e.g. https://api.openai.com/v1`,
      400,
    );
  }

  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${body.apiKey}`,
    },
    body: JSON.stringify({ model: body.model, messages: body.messages }),
  }).catch((error: unknown) => {
    console.error(`agent proxy: fetch to ${url} failed:`, error);
    return null;
  });

  if (!upstream) return failure(`cannot reach ${url}`, 502);

  // Passed through verbatim, success or failure: the client parses the same
  // OpenAI-completions shape (or its `error` field) either way.
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
