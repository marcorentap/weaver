import { z } from "zod";
import {
  builtinImagesProviders,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { providerUrl } from "./provider.js";

/**
 * What the model a run names can do with pictures: whether it takes image
 * input, and whether it makes images instead of text.
 *
 * Weaver talks to arbitrary OpenAI-completions endpoints, and the model is a
 * free-text id, so there is no local place to look the answer up. The
 * endpoint itself is the best source: every one of them serves `GET /models`,
 * and most describe a model's modalities there. Providers that say nothing
 * useful get a second opinion from pi's bundled catalogs, chat models and
 * image models alike, matched by model id across every provider it knows.
 * Only when both stay silent does a model count as text-only — the
 * conservative answer, since attaching an image to a request that cannot
 * take one fails the whole run, while sending only the description costs a
 * line; and the same silence keeps a run on the chat-completions path rather
 * than sending an ordinary conversation to an image endpoint.
 *
 * The question is asked per run. `modelTakesImages` is only asked when the
 * run's context actually carries a picture, so a run with nothing to show
 * never pays for it (see `spliceContext` in `run-agent.ts` for the consumer).
 * `modelOutputsImages` is asked before every run, because the endpoint it
 * names decides whether the run is a chat call at all: the listing is fetched
 * once per endpoint and kept for the life of the process, so the cost is one
 * request per provider.
 */

/** A provider's `/models` listing, as far as modalities go. Every provider
 *  wraps its entries differently and adds fields this does not know, so the
 *  entries stay opaque records: `entryModalities` reads the few shapes that
 *  are known and says "no opinion" about everything else. */
const listing = z.object({
  data: z.array(z.record(z.string(), z.unknown())).optional(),
});

const IMAGE = "image";

/** An array of strings, or null when the value is anything else. A field
 *  that is present but not a string array is one this code does not know,
 *  which is not the same as a field that says "text only". */
function strings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === "string")) return null;
  return value as string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** What one direction of one listing entry says, or null for an entry that
 *  says nothing either way. Kept as the raw modality list rather than a
 *  verdict so the input and output sides can read the same field without
 *  one of them deciding what the other sees. */
type Modalities = {
  input: string[] | null;
  output: string[] | null;
};

/**
 * What one listing entry says about input and output modalities. The shapes
 * read here are the ones providers actually use — OpenRouter's
 * `architecture.input_modalities`/`output_modalities`, flat
 * `input_modalities`/`output_modalities`, a `modalities` object with
 * `input`/`output`, a `supports_image_input` flag, and a `capabilities.vision`
 * flag. A field that is present and decidable is trusted, so an entry that
 * lists `["text"]` for output is not sent on to pi's catalog for a second
 * guess.
 */
function entryModalities(entry: Record<string, unknown>): Modalities {
  const architecture = record(entry.architecture);
  const modalities = record(entry.modalities);
  const capabilities = record(entry.capabilities);
  const vision =
    typeof capabilities?.vision === "boolean"
      ? capabilities.vision
      : typeof entry.supports_image_input === "boolean"
        ? entry.supports_image_input
        : null;
  return {
    input:
      strings(architecture?.input_modalities) ??
      strings(entry.input_modalities) ??
      strings(modalities?.input) ??
      (vision === null ? null : vision ? [IMAGE] : ["text"]),
    output:
      strings(architecture?.output_modalities) ??
      strings(entry.output_modalities) ??
      strings(modalities?.output),
  };
}

/**
 * The ids pi's bundled catalogs know, in the two sets weaver asks about,
 * built once on first use. The catalog is per provider, and the same id (a
 * `gpt-4o`, a `claude-*`) appears under several with the same modalities, so
 * the ids are flattened rather than keyed by the provider weaver is not
 * talking to. The image catalog is separate — those models never appear in
 * the chat catalog, since they are reached through the image API rather than
 * through a completion — and its models are counted as taking image input
 * too, because every one of them generates from a picture as readily as from
 * text.
 */
let catalog: { vision: Set<string>; image: Set<string> } | null = null;

function catalogModalities(): { vision: Set<string>; image: Set<string> } {
  if (catalog !== null) return catalog;
  const vision = new Set<string>();
  const image = new Set<string>();
  for (const provider of getBuiltinProviders()) {
    for (const builtin of getBuiltinModels(provider)) {
      if (builtin.input.includes(IMAGE)) vision.add(builtin.id);
    }
  }
  for (const provider of builtinImagesProviders()) {
    for (const builtin of provider.getModels()) {
      image.add(builtin.id);
      if (builtin.input.includes(IMAGE)) vision.add(builtin.id);
    }
  }
  catalog = { vision, image };
  return catalog;
}

/**
 * Listings already fetched, keyed by endpoint. What a model can do is a
 * property of the provider, not of the API key, and it does not change over
 * the life of a session, so one request per endpoint is enough. The promise
 * is cached rather than the result, so two runs starting together — and the
 * two questions above, asked at different moments — share one fetch instead
 * of racing.
 */
const listings = new Map<string, Promise<Map<string, Modalities>>>();

async function fetchListing(
  endpoint: string,
  apiKey: string,
): Promise<Map<string, Modalities>> {
  const entries = new Map<string, Modalities>();
  const url = providerUrl(endpoint, "models");
  if (!url) return entries;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  }).catch(() => null);
  if (!response?.ok) return entries;
  const payload = await response.json().catch(() => null);
  const parsed = listing.safeParse(payload);
  if (!parsed.success) return entries;
  for (const entry of parsed.data.data ?? []) {
    const id = entry.id;
    if (typeof id === "string") entries.set(id, entryModalities(entry));
  }
  return entries;
}

async function modalitiesOf(
  endpoint: string,
  apiKey: string,
  model: string,
): Promise<Modalities | null> {
  let pending = listings.get(endpoint);
  if (!pending) {
    pending = fetchListing(endpoint, apiKey);
    listings.set(endpoint, pending);
  }
  return (await pending).get(model) ?? null;
}

export async function modelTakesImages(
  endpoint: string,
  apiKey: string,
  model: string,
): Promise<boolean> {
  const listed = await modalitiesOf(endpoint, apiKey, model);
  if (listed?.input) return listed.input.includes(IMAGE);
  return catalogModalities().vision.has(model);
}

/**
 * Whether a run on this model should not be a chat call at all: the model
 * makes pictures, which no chat completion returns (a provider that offers
 * both routes a picture-making model through its image API, not through a
 * completion with `modalities`). The endpoint's listing is the first word on
 * this, as it is for input, and pi's image catalog the second; a model
 * neither knows is a chat model, which is what every run has always assumed.
 */
export async function modelOutputsImages(
  endpoint: string,
  apiKey: string,
  model: string,
): Promise<boolean> {
  const listed = await modalitiesOf(endpoint, apiKey, model);
  if (listed?.output) return listed.output.includes(IMAGE);
  return catalogModalities().image.has(model);
}
