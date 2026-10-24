import { z } from "zod";
import type { ContextImage } from "@repo/core";
import { providerUrl } from "./provider.js";
import { readImage } from "./read-source.js";

/**
 * One picture an image model produced, as the file it should become. The
 * bytes are in memory here and on the disk once `run-agent.ts` writes them
 * into the session's artifacts directory; a media block points at the file,
 * never at a data URL, so a generated image is a block like any other — it
 * can be opened, moved into a later run, and replayed above one.
 */
export type GeneratedImage = {
  bytes: Uint8Array;
  /** The extension the media protocol serves the file under, taken from the
   *  format the provider said it returned. */
  extension: string;
};

/** A generation request, as the run engine knows it. */
export type ImageRequest = {
  endpoint: string;
  apiKey: string;
  model: string;
  /** The whole ask, material above the block and the block itself, as one
   *  prompt: an image API takes a single string, not a transcript. */
  prompt: string;
  /** Pictures the run is asked about — the anchoring block's own — sent as
   *  reference images for image-to-image work. Anything that cannot be read
   *  is dropped rather than failing the request around it. */
  references: ContextImage[];
  /** The directory a reference's scheme-less path resolves against, the
   *  same merged `WEAVER_PWD` the run's pictures are read with. */
  cwd: string;
  /** Extra request headers — the app attribution a provider's usage panel
   *  counts, on the endpoint that asks for it. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/**
 * A provider's image-generation response, as far as this app reads it.
 *
 * The shape is the one OpenRouter's Image API documents
 * (https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
 * and OpenAI's images endpoint shares: a `data` array of base64 images, each
 * with the format it came back in. `media_type` is optional because older
 * endpoints omit it; a missing type is a png, which is the format every one
 * of them falls back on.
 */
const imageResponse = z.object({
  data: z
    .array(
      z.object({
        b64_json: z.string(),
        media_type: z.string().optional(),
      }),
    )
    .optional(),
  error: z.union([z.string(), z.object({ message: z.string() })]).nullish(),
});

/** The extension a media type's file takes. A type this app does not know is
 *  written as a png on the grounds that the bytes are a picture either way,
 *  and an extension the media protocol has a viewer for beats an honest
 *  `bin` that renders as "no preview". */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

function extensionOf(mimeType: string | undefined): string {
  return EXTENSIONS[(mimeType ?? "").toLowerCase()] ?? "png";
}

/** The provider's own words for a failed call: its JSON `error` when the body
 *  is one, its raw text otherwise, and the status when there is no body at
 *  all. */
function failure(status: number, raw: string): string {
  let message: string | null = null;
  try {
    const parsed = z
      .object({
        error: z.union([z.string(), z.object({ message: z.string() })]),
      })
      .safeParse(JSON.parse(raw));
    if (parsed.success) {
      message =
        typeof parsed.data.error === "string"
          ? parsed.data.error
          : parsed.data.error.message;
    }
  } catch {
    // Not JSON: the raw text below is the best account of what happened.
  }
  if (message) return message;
  return raw.trim() || `image generation failed with HTTP ${status}`;
}

/**
 * Ask an image model for pictures, one request for the whole prompt.
 *
 * The request goes to `<endpoint>/images`, not to a chat completion: a model
 * whose output is pictures has no reply to stream, and the dedicated route is
 * the one that takes a prompt and a handful of reference images and returns
 * the bytes. Nothing here streams — an image arrives whole or not at all, and
 * the docs' billing is all-or-nothing on the same terms — so the caller has
 * only the finished pictures or an error to report.
 */
export async function generateImages(
  request: ImageRequest,
): Promise<GeneratedImage[]> {
  const url = providerUrl(request.endpoint, "images");
  if (!url) throw new Error("the endpoint is not a usable URL");

  const references: unknown[] = [];
  for (const reference of request.references) {
    const image = await readImage(reference.uri, request.cwd).catch(() => null);
    if (!image?.data) continue;
    references.push({
      type: "image_url",
      image_url: {
        url: `data:${image.mimeType};base64,${image.data}`,
      },
    });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${request.apiKey}`,
      "content-type": "application/json",
      ...request.headers,
    },
    body: JSON.stringify({
      model: request.model,
      prompt: request.prompt,
      ...(references.length > 0 ? { input_references: references } : {}),
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  }).catch((error: unknown) => {
    throw new Error(
      `cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(failure(response.status, raw));

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`unexpected response from ${url}: ${raw}`);
  }
  const parsed = imageResponse.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`unexpected response from ${url}: ${raw}`);
  }
  const reported =
    typeof parsed.data.error === "string"
      ? parsed.data.error
      : parsed.data.error?.message;
  if (reported) throw new Error(reported);

  const images = (parsed.data.data ?? []).map((image) => ({
    bytes: new Uint8Array(Buffer.from(image.b64_json, "base64")),
    extension: extensionOf(image.media_type),
  }));
  if (images.length === 0) {
    throw new Error("the endpoint returned no image");
  }
  return images;
}
