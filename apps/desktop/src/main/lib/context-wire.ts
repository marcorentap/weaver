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
  pwd: string,
): Promise<Record<string, unknown>[]> {
  const text = { role: message.role, content: message.content };
  if (!message.images?.length) return [text];
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
): Promise<unknown> {
  // Nothing to say: a run whose context is empty and whose own block shows
  // no picture leaves the payload exactly as pi built it.
  if (context.length === 0 && anchorImages.length === 0) return payload;
  const parsed = chatPayload.safeParse(payload);
  if (!parsed.success) return payload;
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
  const contextMessages = vision
    ? (
        await Promise.all(context.map((message) => wireMessage(message, pwd)))
      ).flat()
    : // A model that takes no images still gets the text, but only the text:
      // `images` is weaver's own field and has no business on the wire, where
      // a strict provider would reject the message outright.
      context.map(({ role, content }) => ({ role, content }));
  const [first, ...rest] = placed;
  // Only a message whose role is actually `system` is kept in front of the
  // context. An agent run always has pi's system prompt there, but a plain
  // run has none, and its first message is the user turn it is asked to
  // answer — treating that as the system message would push the context
  // below the ask it is supposed to sit above, and leave the ask in the
  // system slot.
  return {
    ...parsed.data,
    messages:
      first?.role === "system"
        ? [first, ...contextMessages, ...rest]
        : [...contextMessages, ...placed],
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
): SimpleStreamOptions {
  const hook = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const next = hook ? await hook(payload, model) : payload;
      return spliceContext(next ?? payload, context, vision, pwd, anchorImages);
    },
  };
}
