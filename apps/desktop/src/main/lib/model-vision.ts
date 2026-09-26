import { z } from "zod";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { providerUrl } from "./provider.js";

/**
 * Whether the model a run names takes image input.
 *
 * Weaver talks to arbitrary OpenAI-completions endpoints, and the model is a
 * free-text id, so there is no local place to look the answer up. The
 * endpoint itself is the best source: every one of them serves `GET /models`,
 * and most describe a model's input modalities there. Providers that say
 * nothing useful get a second opinion from pi's bundled catalog, matched by
 * model id across every provider it knows. Only when both stay silent does a
 * model count as text-only — the conservative answer, since attaching an
 * image to a request that cannot take one fails the whole run, while sending
 * only the description costs a line.
 *
 * The question is asked per run, and only when the run's context actually
 * carries an image; a run with nothing to show never pays for it. See
 * `spliceContext` in `run-agent.ts` for the consumer.
 */

/** A provider's `/models` listing, as far as image input goes. Every
 *  provider wraps its entries differently and adds fields this does not
 *  know, so the entries stay opaque records: `entryVerdict` reads the few
 *  shapes that are known and says "no opinion" about everything else. */
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

/**
 * What one listing entry says about image input: true, false, or null for an
 * entry that says nothing either way. The shapes read here are the ones
 * providers actually use — OpenRouter's `architecture.input_modalities`,
 * a flat `input_modalities`, `modalities.input`, a `supports_image_input`
 * flag, and a `capabilities.vision` flag. A field that is present and
 * decidable is trusted, so an entry that lists `["text"]` is text-only and
 * is not sent on to the catalog for a second guess.
 */
function entryVerdict(entry: Record<string, unknown>): boolean | null {
  const architecture = record(entry.architecture);
  if (architecture) {
    const modalities = strings(architecture.input_modalities);
    if (modalities) return modalities.includes(IMAGE);
  }
  const inputModalities = strings(entry.input_modalities);
  if (inputModalities) return inputModalities.includes(IMAGE);
  const modalities = record(entry.modalities);
  if (modalities) {
    const input = strings(modalities.input);
    if (input) return input.includes(IMAGE);
  }
  if (typeof entry.supports_image_input === "boolean") {
    return entry.supports_image_input;
  }
  const capabilities = record(entry.capabilities);
  if (capabilities && typeof capabilities.vision === "boolean") {
    return capabilities.vision;
  }
  return null;
}

/**
 * Model ids the bundled catalog knows take images, built once on first use.
 * pi's catalog is per provider, and the same id (a `gpt-4o`, a `claude-*`)
 * appears under several with the same modalities, so the ids are flattened
 * into one set rather than keyed by the provider weaver is not talking to.
 */
let catalogIds: Set<string> | null = null;

function catalogTakesImages(model: string): boolean {
  if (catalogIds === null) {
    catalogIds = new Set();
    for (const provider of getBuiltinProviders()) {
      for (const builtin of getBuiltinModels(provider)) {
        if (builtin.input.includes(IMAGE)) catalogIds.add(builtin.id);
      }
    }
  }
  return catalogIds.has(model);
}

/**
 * Listings already fetched, keyed by endpoint. Which models take images is a
 * property of the provider, not of the API key, and it does not change over
 * the life of a session, so one request per endpoint is enough. The promise
 * is cached rather than the result, so two runs starting together share one
 * fetch instead of racing.
 */
const listings = new Map<string, Promise<Map<string, boolean | null>>>();

async function fetchListing(
  endpoint: string,
  apiKey: string,
): Promise<Map<string, boolean | null>> {
  const verdicts = new Map<string, boolean | null>();
  const url = providerUrl(endpoint, "models");
  if (!url) return verdicts;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  }).catch(() => null);
  if (!response?.ok) return verdicts;
  const payload = await response.json().catch(() => null);
  const parsed = listing.safeParse(payload);
  if (!parsed.success) return verdicts;
  for (const entry of parsed.data.data ?? []) {
    const id = entry.id;
    if (typeof id === "string") verdicts.set(id, entryVerdict(entry));
  }
  return verdicts;
}

export async function modelTakesImages(
  endpoint: string,
  apiKey: string,
  model: string,
): Promise<boolean> {
  let pending = listings.get(endpoint);
  if (!pending) {
    pending = fetchListing(endpoint, apiKey);
    listings.set(endpoint, pending);
  }
  const verdict = (await pending).get(model) ?? null;
  return verdict ?? catalogTakesImages(model);
}
