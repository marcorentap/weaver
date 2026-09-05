import type { ReactNode } from "react";
import type { Block } from "@repo/core";
import { GROUP_KIND, TEXT_KIND, textState } from "@repo/core";
import { schemaMessage } from "@/lib/schema-error";
import { MediaText } from "@/components/media-text";
import { MarkdownText } from "@/components/markdown";
import { CodeBlock, languageForPath } from "@/components/code";
import { cn } from "@/lib/utils";
import { kinds } from "@shared/blocks/kinds.js";
import type { MediaState } from "./media";
import {
  MEDIA_KIND,
  mediaInfo,
  mediaName,
  mediaSrc,
  mediaState,
} from "./media";
import { USER_KIND, userState } from "@shared/blocks/user.js";
import type { ToolState } from "@shared/blocks/tool.js";
import { TOOL_KIND, toolLanguage, toolState } from "@shared/blocks/tool.js";

/** One editable entry of a block's state, offered in its actions menu. */
export type BlockField = {
  /** Key in `block.data` that the edit writes. */
  name: string;
  label: string;
  value: string;
  /** What an empty `value` actually resolves to at run time. Shown in the
   *  actions menu in place of a blank, and as the editor's placeholder, so
   *  an inherited default is visible instead of looking unset. */
  placeholder?: string;
  /** Content rather than a label. The editor gives it a text area where
   *  enter inserts a newline, and the row renders every line of it. */
  multiline?: boolean;
  /** `value`'s real type once parsed. A `"number"` field round-trips
   *  through `Number()` before it's written; everything else stays a
   *  string as-is. */
  type?: "number";
};

/**
 * How a kind renders its row. The rail itself is uniform, one solid node per
 * block, so a kind only decides what its state looks like as content.
 *
 * Each view parses `block.data` through its kind's schema, so components
 * receive complete state and never guess at missing fields. `nested` is the
 * number of blocks nested directly inside this one. A block only links to
 * the first of them, so counting is the caller's job, not a view's.
 *
 * Rows are not limited to one line. This is a GUI, so a kind renders its
 * content inline. Beyond that a kind may add editable `fields`, a full-size
 * `Preview`, and a `raw` URL the underlying file can be opened at.
 */
export type BlockView = {
  Row: (props: { block: Block; nested: number; running: boolean }) => ReactNode;
  fields?: (block: Block) => BlockField[];
  Preview?: (props: { block: Block }) => ReactNode;
  raw?: (block: Block) => string;
};

function UserRow({ text, running }: { text: string; running: boolean }) {
  return (
    <span className="flex min-w-0 flex-1 items-start gap-2">
      <span className="min-w-0 flex-1 whitespace-pre-wrap">
        {text || "(empty)"}
      </span>
      {running ? (
        <span className="shrink-0 animate-pulse text-muted-foreground">
          running…
        </span>
      ) : null}
    </span>
  );
}

function ToolRow({ state }: { state: ToolState }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0">{state.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {state.args}
        </span>
      </span>
      {state.output === "" ? null : (
        // Every tool prints machine output, not prose, so it all renders
        // preformatted and obeys the wrap setting; `toolLanguage` is the one
        // spot that knows which calls have a grammar to highlight it with.
        <CodeBlock
          code={state.output}
          language={toolLanguage(state)}
          className={cn(
            "w-full overflow-x-auto border p-2",
            state.ok ? "text-muted-foreground" : "text-destructive",
          )}
        />
      )}
    </span>
  );
}

/**
 * A text-based block's "open in a new tab", the same affordance a media
 * block gets from a real URL, built from the text already in the block's own
 * state. A `data:` URL would be simpler (no object to release), but Chrome
 * refuses to navigate a new tab to one from `window.open` even on a real
 * click. An object URL is not subject to that restriction. The caller is
 * responsible for revoking it once the tab has had a chance to load it.
 */
function textBlobUrl(text: string): string {
  return URL.createObjectURL(new Blob([text], { type: "text/plain" }));
}

/** Full-size presentation: header line, then the same output a row shows,
 * scrolling on its own instead of clipping. */
function ToolPreview({ state }: { state: ToolState }) {
  return (
    <div className="flex h-[70vh] w-full flex-col gap-2">
      <div className="flex min-w-0 shrink-0 items-baseline gap-2">
        <span className="shrink-0 font-medium">{state.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {state.args}
        </span>
      </div>
      {state.output === "" ? (
        <p className="text-muted-foreground">No output.</p>
      ) : (
        <CodeBlock
          code={state.output}
          language={toolLanguage(state)}
          className={cn(
            "min-h-0 flex-1 overflow-auto overscroll-contain",
            state.ok ? "text-muted-foreground" : "text-destructive",
          )}
        />
      )}
    </div>
  );
}

/**
 * Media renders inline. Big enough to actually watch or read a frame of, small
 * enough that a list of blocks still scrolls like a list; `p` opens the
 * full-size preview.
 */
function MediaRow({ state }: { state: MediaState }) {
  const { type, mime } = mediaInfo(state.uri);
  const src = mediaSrc(state.uri);

  return (
    <span className="flex min-w-0 items-center gap-2">
      {type === "image" ? (
        // A media block's URI is arbitrary, any host or a local file behind
        // the media protocol, so a fixed remotePatterns allowlist can't
        // serve it.
        // `max-height` alone leaves an intrinsically small image (an icon-size
        // svg, say) at its natural size instead of filling the row; a fixed
        // `h-48` plus `object-contain` scales every image up or down to it.
        <img
          src={src}
          alt=""
          className="h-48 w-48 shrink-0 border object-contain"
        />
      ) : null}
      {type === "video" ? (
        <video
          src={src}
          controls
          muted
          preload="metadata"
          className="max-h-48 shrink-0 border"
        />
      ) : null}
      {type === "audio" ? (
        <audio src={src} controls className="h-8 w-72 shrink-0" />
      ) : null}
      {type === "pdf" ? (
        // Chrome's viewer ignores `scrollbar=0`, so the frame is oversized by
        // a scrollbar's width in both axes and the wrapper clips them off.
        <span className="block h-48 w-40 shrink-0 overflow-hidden border">
          <iframe
            src={`${src}#toolbar=0&navpanes=0&view=FitH`}
            title={mediaName(state.uri)}
            className="pointer-events-none h-[calc(12rem+20px)] w-[calc(10rem+20px)]"
          />
        </span>
      ) : null}
      {type === "youtube" ? (
        <iframe
          src={src}
          title={mediaName(state.uri)}
          className="pointer-events-none h-48 w-72 shrink-0 border"
        />
      ) : null}
      {type === "text" ? (
        // No fixed height or overflow of its own. The row's own clip (see
        // BlockRow) is what caps this and drives the "truncated" marker,
        // same as a text or tool block's content. A fixed box here would
        // silently hide overflow the row-level clip never sees, so the
        // marker would never show no matter how much longer the file is.
        <MediaText
          src={src}
          markdown={mime === "text/markdown"}
          language={languageForPath(mediaName(state.uri))}
          className="pointer-events-none w-96 shrink-0"
        />
      ) : null}
      {type === "unknown" ? (
        // Nothing renders this extension. In a row `enter` opens the actions
        // menu, so the row stops at the reason; the preview is where `enter`
        // hands the file to the browser.
        <span className="truncate text-muted-foreground">
          No viewer for this extension.
        </span>
      ) : null}
    </span>
  );
}

/** Full-size presentation, one element per detected type. */
function MediaPreview({ state }: { state: MediaState }) {
  const { type, mime } = mediaInfo(state.uri);
  const src = mediaSrc(state.uri);

  if (type === "image") {
    return (
      // Arbitrary URI, as in MediaRow.
      <img src={src} alt="" className="max-h-[70vh] w-auto object-contain" />
    );
  }
  if (type === "video") {
    return <video src={src} controls autoPlay className="max-h-[70vh] w-full" />;
  }
  if (type === "audio") {
    return <audio src={src} controls autoPlay className="w-full" />;
  }
  if (type === "pdf") {
    return <iframe src={src} title="pdf" className="h-[70vh] w-full" />;
  }
  if (type === "youtube") {
    return (
      <iframe
        src={src}
        title={mediaName(state.uri)}
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
        className="h-[70vh] w-full"
      />
    );
  }
  if (type === "text") {
    return (
      <MediaText
        src={src}
        markdown={mime === "text/markdown"}
        language={languageForPath(mediaName(state.uri))}
        className="h-[70vh] w-full overflow-auto overscroll-contain"
      />
    );
  }
  return (
    <p className="text-muted-foreground">
      No viewer for this extension. Press enter to open in new tab
    </p>
  );
}

export const blockViews: Record<string, BlockView> = {
  [TEXT_KIND]: {
    // A text block is content, not a label. It renders as markdown, so an
    // agent's prose, a table or a fenced code block reads as itself rather
    // than as its source characters.
    Row: ({ block }) => (
      <MarkdownText
        text={textState.parse(block.data).text}
        className="flex-1 text-muted-foreground"
      />
    ),
    fields: (block) => [
      {
        name: "text",
        label: "text",
        value: textState.parse(block.data).text,
        multiline: true,
      },
    ],
    Preview: ({ block }) => (
      <MarkdownText
        text={textState.parse(block.data).text}
        className="h-[70vh] w-full overflow-auto overscroll-contain"
      />
    ),
    raw: (block) => textBlobUrl(textState.parse(block.data).text),
  },

  [GROUP_KIND]: {
    Row: ({ nested }) => (
      <span className="truncate text-muted-foreground italic">
        {nested} nested
      </span>
    ),
  },

  [MEDIA_KIND]: {
    Row: ({ block }) => <MediaRow state={mediaState.parse(block.data)} />,
    fields: (block) => [
      { name: "uri", label: "URI", value: mediaState.parse(block.data).uri },
    ],
    Preview: ({ block }) => (
      <MediaPreview state={mediaState.parse(block.data)} />
    ),
    // The embed URL `mediaSrc` builds for a YouTube video is only good for
    // an iframe; "open in new tab" should land on the actual watch page.
    raw: (block) => {
      const uri = mediaState.parse(block.data).uri;
      return mediaInfo(uri).type === "youtube" ? uri : mediaSrc(uri);
    },
  },

  [USER_KIND]: {
    Row: ({ block, running }) => (
      <UserRow text={userState.parse(block.data).text} running={running} />
    ),
    fields: (block) => [
      {
        name: "text",
        label: "text",
        value: userState.parse(block.data).text,
        multiline: true,
      },
    ],
  },

  [TOOL_KIND]: {
    Row: ({ block }) => <ToolRow state={toolState.parse(block.data)} />,
    fields: (block) => {
      const state = toolState.parse(block.data);
      return [
        { name: "name", label: "tool", value: state.name },
        { name: "args", label: "args", value: state.args },
        {
          name: "output",
          label: "output",
          value: state.output,
          multiline: true,
        },
      ];
    },
    Preview: ({ block }) => <ToolPreview state={toolState.parse(block.data)} />,
    raw: (block) => textBlobUrl(toolState.parse(block.data).output),
  },
};

/**
 * Unknown kinds still render, unlike snapshots which throw. A missing view is
 * a cosmetic gap; a missing snapshot would silently change what the LLM reads.
 */
export const fallbackView: BlockView = {
  Row: ({ block }) => (
    <span className="truncate text-muted-foreground">
      unregistered kind: {block.kind}
    </span>
  ),
};

/**
 * A block whose data does not satisfy its kind. Views parse strictly, so one
 * malformed block would otherwise throw through the whole page. The store
 * only validates kinds it knows about, so this state is reachable.
 *
 * Its fields come from the raw data rather than parsed state, which is what
 * makes the block repairable instead of only deletable.
 */
function invalidView(message: string): BlockView {
  return {
    Row: () => (
      <span className="truncate text-destructive">invalid state: {message}</span>
    ),
    fields: (block) =>
      Object.entries(block.data).flatMap(([name, value]) =>
        typeof value === "string" ? [{ name, label: name, value }] : [],
      ),
  };
}

/**
 * Blocks are immutable objects handed down from the server, so a block that
 * parsed once parses the same way forever. Without this every keystroke in
 * chat re-validates every visible block's state.
 */
const resolved = new WeakMap<Block, BlockView>();

/**
 * The view a block renders through. Its kind's, unless its state fails that
 * kind's schema.
 */
export function viewFor(block: Block): BlockView {
  const cached = resolved.get(block);
  if (cached) return cached;

  const kind = kinds[block.kind];
  let view = blockViews[block.kind] ?? fallbackView;
  if (kind) {
    try {
      kind.parse(block.data);
    } catch (error) {
      view = invalidView(schemaMessage(error));
    }
  }

  resolved.set(block, view);
  return view;
}
