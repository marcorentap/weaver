import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ContextImage, ContextMessage } from "@repo/core";
import { resolveMediaUri } from "@plugins/rich-media";

/**
 * Getting a weaver graph into the request pi built, as turns rather than as
 * one blob, and as pictures rather than as prose about pictures.
 *
 * This is the one seam where the graph touches the wire. pi assembles each
 * request from its session's own message list, and that list has no room for
 * what weaver sends: the graph above the block, turn by turn, with every
 * block that is neither a user nor an assistant turn in the `developer`
 * role. `onPayload` is the one point at which the finished payload can still
 * be rewritten, so the graph goes in there — after the system prompt and
 * ahead of the session's own messages, the first of which is the anchoring
 * block's content (and, in a plain run, ahead of the run's own prompt, so
 * the material reads above the ask). The block being run therefore stays the
 * model's last turn, and the turns pi builds after it (a tool call and its
 * result) stay where they are, so a run's own work is never reshuffled.
 *
 * It lives in its own module because it is the half of a run that touches
 * the filesystem and the payload without knowing what a session, a tool, or
 * a plugin is; a run hands it a context and a model's capabilities and gets
 * a request back.
 */

/**
 * The request bodies a run's context is spliced into. The provider weaver
 * mounts speaks `openai-completions`, whose payload is `{ messages, … }`;
 * anything shaped differently is left alone rather than guessed at.
 */
const chatPayload = z
  .object({ messages: z.array(z.record(z.string(), z.unknown())) })
  .passthrough();

/**
 * The lead that introduces a turn's pictures on the wire. An image part
 * carries no words of its own, and every picture weaver attaches sits after
 * the block that described it, so a line naming what follows keeps the
 * request readable to a model that skims. It is the same idea as pi's own
 * `"Attached image(s) from tool result:"`.
 */
const ATTACHED_IMAGES = "Attached image(s) from the context above:";

/**
 * What a tool message says when the call produced no text, which is the same
 * string pi's request builder substitutes for the same reason: a `tool`
 * message with an empty `content` is rejected by some providers, and a call
 * that printed nothing is still an answered call.
 */
export const NO_TOOL_OUTPUT = "(no tool output)";

export const SEE_ATTACHED_IMAGE = "(see attached image)";

/**
 * The line an OpenAI-compatible request puts in front of the pictures a tool
 * result carried, word for word as pi writes it (`convertMessages` in its
 * openai-completions API). It is a copy of pi's string on purpose: a replay
 * that says it differently is a replay of a message nobody sent, which is the
 * one thing this whole projection exists to avoid.
 */
const TOOL_RESULT_IMAGES = "Attached image(s) from tool result:";

/**
 * The projection, stated once.
 *
 * Every request weaver sends is an OpenAI chat-completions transcript, and
 * the graph is its record. A run must be able to replay, from the graph, the
 * transcript the run before it sent — otherwise the provider's prefix cache
 * misses at the first message that differs, and the whole conversation after
 * it is billed as fresh input. That only holds if both directions agree on
 * one shape, so this is that shape: `canonicalMessage` folds whatever pi and
 * a run's own tools produced into it, and `wireMessage` below writes only
 * that shape. `canonical(transcript)` is therefore a fixed point of the
 * round trip: graph → transcript → graph → transcript never drifts.
 *
 * The form is the standard Chat Completions union, in the standard spelling:
 *
 * - `content` is a plain string whenever the message is text, which is what
 *   the standard says a message's content is; an array of parts exists only
 *   when there is something a string cannot carry — an image, an audio
 *   clip — and a text part beside one is kept only if it says something.
 *   pi sends every user message as a one-part array; the anchor prompt weaver
 *   splices in is then spelled exactly like the prompt a later run replays
 *   from the graph, which is a plain string.
 * - An assistant message that called tools and said nothing has `content:
 *   ""` rather than `null`. Both are accepted by the standard; only one of
 *   them is what the graph can write back, since a block has no way to be
 *   absent-but-present.
 * - Reasoning lives in `reasoning_content`, whatever field pi received it in
 *   (`reasoning`, `reasoning_text`). Empty reasoning is no reasoning.
 * - Tool calls are `{ id, type: "function", function: { name, arguments } }`,
 *   and `arguments` is the JSON string the provider sent, re-encoded with its
 *   object keys in sorted order. The order costs nothing — no provider reads
 *   it — and it is the difference between a call whose arguments the model
 *   happened to write as `{"uri":…,"label":…}` and one it wrote the other
 *   way round matching its replay.
 * - A `tool` message always has text: an empty result becomes
 *   `NO_TOOL_OUTPUT`, the same placeholder pi would have sent.
 *
 * Fields this union has no room for are left on the message untouched rather
 * than deleted (`reasoning_details` is the one that matters: OpenRouter's
 * signed reasoning, which a thinking model needs back after a tool call).
 * They are outside the projection — the graph does not hold them, so a later
 * run's replay cannot carry them — and keeping them means the run that first
 * sent them still reached the model intact.
 */
export type WireContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | Record<string, unknown>;

export type WireToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
  [key: string]: unknown;
};

export type WireMessage = {
  role: string;
  content: string | WireContentPart[];
  name?: string;
  reasoning_content?: string;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
};

/** Recursively sort object keys, so the same arguments encode the same way
 *  whichever order they arrived in. Arrays keep their order, which is
 *  meaningful; object key order is not. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortedKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

/** A tool call's arguments in canonical form: the provider's JSON, parsed and
 *  re-encoded with sorted keys. A string that is not JSON is kept as it came
 *  — there is nothing to normalize, and inventing a shape for it would make
 *  the replay disagree with what was sent. */
export function canonicalArguments(args: string): string {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    return args;
  }
  return JSON.stringify(sortedKeys(value));
}

/** A message's content in canonical form: a string when it is text, an array
 *  of parts only when something in it is not. */
function canonicalContent(content: unknown): string | WireContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: WireContentPart[] = [];
  let textOnly = true;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const one = part as Record<string, unknown>;
    if (one.type === "text") {
      parts.push({
        type: "text",
        text: typeof one.text === "string" ? one.text : "",
      });
      continue;
    }
    textOnly = false;
    if (one.type === "image_url") {
      const image = one.image_url as Record<string, unknown> | undefined;
      parts.push({
        type: "image_url",
        image_url: {
          url: image && typeof image.url === "string" ? image.url : "",
        },
      });
      continue;
    }
    // A part with no shape in this projection — audio, a file reference:
    // keep it rather than shred it. Weaver never writes one, so it can only
    // have come from pi's own request, and dropping it would change more of
    // that request than keeping it does.
    parts.push(one);
  }
  if (textOnly) {
    return parts.map((part) => (part as { text: string }).text).join("");
  }
  // An empty text part beside a picture says nothing the picture does not.
  return parts.filter(
    (part) => !(part.type === "text" && (part as { text: string }).text === ""),
  );
}

/** One tool call in canonical form. A non-`function` call (a grammar tool's
 *  `custom` payload) has no shape here and is passed through whole. */
function canonicalToolCall(call: unknown): WireToolCall {
  const one = (call ?? {}) as Record<string, unknown>;
  if (one.type !== undefined && one.type !== "function") {
    return one as WireToolCall;
  }
  const fn = (one.function ?? {}) as Record<string, unknown>;
  return {
    ...one,
    id: typeof one.id === "string" ? one.id : "",
    type: "function",
    function: {
      name: typeof fn.name === "string" ? fn.name : "",
      arguments:
        typeof fn.arguments === "string"
          ? canonicalArguments(fn.arguments)
          : "{}",
    },
  };
}

/** The fields the projection itself writes, in the order it writes them.
 *  Anything else is a provider's own field and follows them unchanged. */
const CANONICAL_FIELDS = new Set([
  "role",
  "content",
  "name",
  "reasoning_content",
  "reasoning",
  "reasoning_text",
  "tool_calls",
  "tool_call_id",
]);

/** One message in canonical form. See `WireMessage` for the whole of the
 *  rule and why it has to be one rule. Keys are written in a fixed order so
 *  that two serializations of one conversation are not merely equivalent but
 *  identical text — the cheapest possible thing to check, and the easiest to
 *  see when it breaks. `threadedReasoning` says the conversation carries
 *  reasoning at all, which makes every assistant message owe the field (see
 *  `canonicalMessages`). */
function canonicalMessage(
  message: Record<string, unknown>,
  threadedReasoning: boolean,
): WireMessage {
  const content = canonicalContent(message.content);
  const isTool = message.role === "tool";
  // An assistant message may say nothing and call a tool; a tool message
  // may print nothing. Both still have to be a string on the wire.
  const next: Record<string, unknown> = {
    role: typeof message.role === "string" ? message.role : "user",
    content:
      isTool && content === ""
        ? NO_TOOL_OUTPUT
        : (content as string | WireContentPart[]),
  };
  if (typeof message.name === "string") next.name = message.name;
  const reasoning = [
    message.reasoning_content,
    message.reasoning,
    message.reasoning_text,
  ].find((value) => typeof value === "string" && value.length > 0) as
    string | undefined;
  if (reasoning !== undefined) next.reasoning_content = reasoning;
  else if (threadedReasoning && message.role === "assistant") {
    // Reasoning the turn did not have, in a conversation that has reasoning:
    // an empty field, not a missing one. Some endpoints (DeepSeek) reject an
    // assistant message that leaves `reasoning_content` out once reasoning is
    // on, which is why pi writes `""` there itself; the graph has no block
    // for a thought nobody had, so the empty string is what a replay writes
    // in the same place. It is written here rather than by the graph's own
    // serializer because only the whole conversation can say whether this one
    // is threaded.
    next.reasoning_content = "";
  }
  if (Array.isArray(message.tool_calls)) {
    next.tool_calls = message.tool_calls.map(canonicalToolCall);
  }
  if (typeof message.tool_call_id === "string") {
    next.tool_call_id = message.tool_call_id;
  }
  // Provider-private fields ride along after the standard ones. The graph
  // does not hold them, so a replay cannot carry them; leaving them on the
  // run that first sent them is still better than dropping them there too.
  for (const [key, value] of Object.entries(message)) {
    if (!CANONICAL_FIELDS.has(key)) next[key] = value;
  }
  return next as WireMessage;
}

/** A transcript in canonical form: every message the projection can express,
 *  normalized to the one shape both directions write.
 *
 * Whether a conversation carries reasoning is a property of the conversation
 * and not of a message, so it is decided here, over the whole list: if any
 * message has a `reasoning_content`, every assistant message gets one, empty
 * where the turn had no thought recorded. That is exactly what pi does for an
 * endpoint that requires the field, so the rule needs no compat flag of its
 * own — a conversation with no reasoning anywhere writes none — and it makes
 * the same conversation come out the same way whether a message came from pi
 * or from the graph. */
export function canonicalMessages(
  messages: Record<string, unknown>[],
): WireMessage[] {
  const threadedReasoning = messages.some(
    (message) =>
      message.role === "assistant" &&
      [
        message.reasoning_content,
        message.reasoning,
        message.reasoning_text,
      ].some((value) => typeof value === "string"),
  );
  return messages.map((message) =>
    canonicalMessage(message, threadedReasoning),
  );
}

/**
 * One context image as a URL a provider can fetch: an http(s) URI as it
 * stands, or a local file read here and inlined as a base64 data URL.
 * `null` when the URI names nothing this process can read — a file that
 * moved, a relative path with no `pwd` to resolve it against — which leaves
 * the turn's own description as the only thing said about it.
 *
 * The bytes are read here rather than carried over IPC because the renderer
 * has no filesystem: a block knows the address of a picture, and this is the
 * process that can open it. Reading the whole file into memory is fine at
 * this size, and a data URL is the one shape every OpenAI-compatible
 * endpoint takes without the run first exposing the file on a port.
 */
async function imageUrl(
  image: ContextImage,
  pwd: string,
): Promise<string | null> {
  const resolved = resolveMediaUri(image.uri, pwd);
  if (!resolved) return null;
  if (!resolved.startsWith("file://")) return resolved;
  try {
    const bytes = await readFile(fileURLToPath(resolved));
    return `data:${image.mimeType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/** The readable URLs among `images`, in order. An image that cannot be read
 *  is dropped rather than failing the request around it. */
async function imageUrls(
  images: ContextImage[],
  pwd: string,
): Promise<string[]> {
  const urls: string[] = [];
  for (const image of images) {
    const url = await imageUrl(image, pwd);
    if (url) urls.push(url);
  }
  return urls;
}

/** A turn's pictures as content parts. */
function imageParts(urls: string[]): unknown[] {
  return urls.map((url) => ({ type: "image_url", image_url: { url } }));
}

/**
 * One context message as the payload's own shape, expanded to as many
 * payload messages as it takes.
 *
 * A text turn is itself, one for one. A `user` turn that carries pictures
 * keeps them inside it, beside the words — they are part of what the person
 * said, and the shape is exactly the one an OpenAI-compatible request takes.
 * A `developer` turn cannot: by every such provider's definition a
 * system/developer message is text, and pi's own adapter reaches the same
 * conclusion, attaching a tool result's images as a following user message
 * rather than inside the tool message. So the material's words stay where
 * they were and its pictures follow as a user turn of their own, under the
 * lead line that says what they are. The order is what matters: the
 * description a block already wrote, then the picture it described. A
 * `developer` turn with nothing written and nothing but pictures to show
 * contributes only the second message.
 */
async function wireMessage(
  message: ContextMessage,
  vision: boolean,
  pwd: string,
): Promise<Record<string, unknown>[]> {
  // A replayed tool result is the answer to a call, and a provider will only
  // take it as a `tool` message quoting that call's id. It is text and
  // nothing else: an image among a tool result's parts travels, in pi's own
  // adapter and in this one alike, as a user message after it.
  if (message.role === "tool") {
    return [
      {
        role: "tool",
        content: message.content === "" ? NO_TOOL_OUTPUT : message.content,
        tool_call_id: message.toolCallId ?? "",
      },
    ];
  }
  const text: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  // The reasoning a model produced before it spoke belongs on its own turn.
  // `reasoning_content` is the field every reasoning-capable
  // OpenAI-compatible endpoint reads, and one some (DeepSeek) require back on
  // every assistant message once tools are in the conversation.
  if (message.reasoning) text.reasoning_content = message.reasoning;
  // Calls are the assistant turn's own, in the shape the wire takes them.
  // The arguments stay a JSON *string* — never an object a provider would
  // have to guess at — but the string itself goes through
  // `canonicalArguments`, the same normalization the outgoing payload gets,
  // so key order cannot make a replay of a call differ from the call.
  if (message.toolCalls?.length) {
    text.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: canonicalArguments(call.args) },
    }));
  }
  // A model that takes no images still gets the text, but only the text:
  // `images` is weaver's own field and has no business on the wire, where a
  // strict provider would reject the message outright.
  if (!vision || !message.images?.length) return [text];
  const urls = await imageUrls(message.images, pwd);
  // Nothing readable: the turn is still its text, and pretending to attach
  // an image it does not have would be worse than saying nothing.
  if (urls.length === 0) return [text];
  if (message.role === "user") {
    return [
      {
        role: "user",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...imageParts(urls),
        ],
      },
    ];
  }
  return [
    ...(message.content ? [text] : []),
    {
      role: "user",
      content: [{ type: "text", text: ATTACHED_IMAGES }, ...imageParts(urls)],
    },
  ];
}

/**
 * The anchoring block's own turn, with the pictures the block holds folded
 * into the turn itself rather than set above it.
 *
 * The block a run is anchored on is what the model is being asked about, so
 * a picture it shows belongs to the ask and not to the material ahead of it:
 * the ask becomes a content-part message, which is the shape a user turn of
 * an OpenAI-shaped request is allowed to take. The renderer cannot do this
 * itself — `prompt` travels as text, because every other prompt is text — so
 * the block's images come along separately as `promptImages` and are folded
 * in here, where the filesystem is. `null` when nothing could be read, which
 * leaves the ask exactly the text it was.
 */
async function wireAnchor(
  anchor: Record<string, unknown>,
  images: ContextImage[],
  pwd: string,
): Promise<Record<string, unknown> | null> {
  const urls = await imageUrls(images, pwd);
  if (urls.length === 0) return null;
  const content = typeof anchor.content === "string" ? anchor.content : "";
  return {
    ...anchor,
    content: [
      ...(content ? [{ type: "text", text: content }] : []),
      ...imageParts(urls),
    ],
  };
}

/** A payload whose `messages` we can read: the shape `chatPayload` parses
 *  out of every OpenAI-compatible request. */
type WirePayload = Record<string, unknown> & {
  messages: Record<string, unknown>[];
};

/**
 * Rename every tool call in a payload to `call_1`, `call_2`, … in the order
 * the payload names them, and point each tool message at the name of the call
 * it answers.
 *
 * pi names a call with the id the provider minted for it, and that id lives
 * only in the session it came from. A later run rebuilds the same transcript
 * from the graph, where the ids are numbered by `transcriptOfBlocks` in
 * exactly this scheme — so without this the two requests agree on every token
 * but the ids, and a provider caches a request by its prefix. The cache would
 * stop dead at the first tool call of every run, which is to say at the first
 * interesting thing an agent does.
 *
 * The numbers mean nothing. Being the same numbers on both sides is the whole
 * of it: same conversation, same ids, whoever serializes it. Pairing is
 * positional because that is what the wire guarantees — the tool messages
 * answering a turn's calls follow it, in the order the calls were made.
 */
function canonicalToolCallIds(payload: WirePayload): WirePayload {
  let calls = 0;
  const renamed = new Map<string, string>();
  const messages = payload.messages.map((message) => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      return {
        ...message,
        tool_calls: message.tool_calls.map((call: unknown) => {
          if (!call || typeof call !== "object") return call;
          const one = call as Record<string, unknown>;
          const id = `call_${++calls}`;
          if (typeof one.id === "string") renamed.set(one.id, id);
          return { ...one, id };
        }),
      };
    }
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      const id = renamed.get(message.tool_call_id);
      return id ? { ...message, tool_call_id: id } : message;
    }
    return message;
  });
  return { ...payload, messages };
}

/**
 * The cache key a run should be routed by, for the one provider that takes
 * one on this API, or null when the endpoint would only reject it.
 *
 * OpenAI's prompt cache is keyed by content, so the key changes nothing
 * about what is cached; it decides which machine holds it. Without one, a
 * long prefix can be cached on one host and asked for on another, and the
 * turn bills in full for no reason anybody can see. pi would place this
 * itself from its session id, but a weaver session is one run and its id is
 * therefore new every time — which is worse than no key at all, because it
 * scatters the same conversation across hosts by design. The key travels
 * from the renderer instead, named after the graph the runs belong to, so
 * every run over one transcript asks the same host.
 *
 * `prompt_cache_key` is an OpenAI field. A strict OpenAI-*compatible* server
 * (llama.cpp, vLLM, a proxy) may reject a request that carries it, so it is
 * only added for the endpoint that documents it.
 */
function cacheKeyFor(cache: { key?: string; baseUrl: string } | null): {
  prompt_cache_key?: string;
} {
  if (!cache?.key) return {};
  if (!cache.baseUrl.includes("api.openai.com")) return {};
  return { prompt_cache_key: cache.key };
}

/**
 * A whole context as the payload's own messages, with the pictures a tool
 * result carried put back where the wire had them: not inside the `tool`
 * message, which is text, but in a `user` turn after it.
 *
 * That is pi's own shape, and not a detail a replay may improve on. A tool
 * result answers a call by its id and says what the tool printed; the bytes
 * of a picture the tool read ride behind it in a user message whose first
 * part names what follows. Folding them into the tool message instead — or
 * dropping them — changes the request at exactly that call, and a provider
 * caches by prefix, so everything after it is billed again on every run.
 *
 * One user message per run of consecutive tool results, not one per result,
 * because that is how pi builds it: it walks a block of consecutive tool
 * results, collects their pictures in order, and emits one message after the
 * last of them. A batch of two calls that each read a picture therefore
 * replays as two tool messages and one picture turn, exactly as it was sent.
 */
async function wireContext(
  context: ContextMessage[],
  vision: boolean,
  pwd: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let images: ContextImage[] = [];
  const flush = async () => {
    if (images.length === 0) return;
    const urls = await imageUrls(images, pwd);
    images = [];
    // Nothing readable: the tool messages are still the answers they were,
    // and a turn holding only a lead line would be a message nobody sent.
    if (urls.length === 0) return;
    out.push({
      role: "user",
      content: [
        { type: "text", text: TOOL_RESULT_IMAGES },
        ...imageParts(urls),
      ],
    });
  };
  for (const message of context) {
    // A replayed tool result keeps its pictures off the message itself: they
    // belong to the turn that follows, and `wireMessage` writes only what a
    // provider takes on a `tool` message.
    if (message.role === "tool") {
      if (vision) images.push(...(message.images ?? []));
      out.push(...(await wireMessage(message, vision, pwd)));
      continue;
    }
    await flush();
    out.push(...(await wireMessage(message, vision, pwd)));
  }
  await flush();
  return out;
}

/**
 * The graph above the run's block, spliced into the request pi built. See
 * the module doc for where the graph sits and why.
 *
 * `vision` says whether the model at the other end takes images. It does not
 * change the text at all — the description a media block already wrote is
 * sent either way — and only decides whether a picture is attached beside
 * it. A run on a text-only model therefore reads exactly as it did before
 * any of this existed, instead of failing on a content part the model cannot
 * take. `anchorImages` are the pictures the block being run holds, folded
 * into its own turn (see `wireAnchor`); `pwd` is the run's working
 * directory, the base a media block's relative path resolves against,
 * exactly as the renderer resolves it to show the file.
 */
export async function spliceContext(
  payload: unknown,
  context: ContextMessage[],
  vision: boolean,
  pwd: string,
  anchorImages: ContextImage[],
  cache: { key?: string; baseUrl: string } | null = null,
): Promise<unknown> {
  const parsed = chatPayload.safeParse(payload);
  if (!parsed.success) return payload;
  // Nothing of the graph to say and no picture of its own: the payload is
  // pi's, exactly as built, except for the call ids it names (see
  // `canonicalToolCallIds`) and the host it is routed to (see
  // `cacheKeyFor`), neither of which changes any token.
  if (context.length === 0 && anchorImages.length === 0) {
    return {
      ...canonicalToolCallIds({
        ...parsed.data,
        messages: canonicalMessages(parsed.data.messages),
      }),
      ...cacheKeyFor(cache),
    };
  }
  const messages = parsed.data.messages;
  // Inside the sender's own messages, the anchoring block is the first turn
  // after the prompt pi wrote for the run — or, in a plain run that has no
  // such prompt, the first turn there is. It is the one pi built from
  // `prompt`, and the one this run is asking about. The prompt leads as a
  // `system` message, or as a `developer` one when the model reasons and the
  // provider wants it that way; both are pi's, neither is the ask.
  const at =
    messages[0]?.role === "system" || messages[0]?.role === "developer" ? 1 : 0;
  const anchor =
    vision && anchorImages.length > 0
      ? await wireAnchor(messages[at] ?? {}, anchorImages, pwd)
      : null;
  const placed = anchor
    ? messages.map((message, index) => (index === at ? anchor : message))
    : messages;
  const contextMessages = await wireContext(context, vision, pwd);
  const [first, ...rest] = placed;
  // The prompt pi wrote for the run stays in front of the context: an agent
  // run always has one there, as `system` — or as `developer`, which pi
  // prefers for a reasoning model — and it is the same message `at` above
  // treats as the run's own rather than the ask. A plain run has no such
  // prompt, and its first message is the user turn it is asked to answer;
  // treating that as the prompt would push the context below the ask it is
  // supposed to sit above, and leave the ask in the prompt's slot.
  // Everything above this line shaped the messages weaver contributes;
  // `canonicalMessages` then puts pi's own messages and ours into the one
  // form a later run can rebuild from the graph. It has to be the last word
  // on the payload, so that what goes out and what a replay writes are the
  // same for the same conversation — see `WireMessage`.
  return {
    ...canonicalToolCallIds({
      ...parsed.data,
      messages: canonicalMessages(
        first?.role === "system" || first?.role === "developer"
          ? [first, ...contextMessages, ...rest]
          : [...contextMessages, ...placed],
      ),
    }),
    ...cacheKeyFor(cache),
  };
}

/**
 * Stream options that splice `context` into whatever request they carry,
 * composing with any payload hook the caller already had (pi hands one to
 * extensions for `before_provider_request`) rather than replacing it.
 */
export function weaveContext(
  options: SimpleStreamOptions,
  context: ContextMessage[],
  vision: boolean,
  pwd: string,
  anchorImages: ContextImage[],
  cache: { key?: string; baseUrl: string } | null = null,
): SimpleStreamOptions {
  const hook = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const next = hook ? await hook(payload, model) : payload;
      return spliceContext(
        next ?? payload,
        context,
        vision,
        pwd,
        anchorImages,
        cache,
      );
    },
  };
}
