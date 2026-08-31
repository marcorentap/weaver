import type { ReactNode } from "react";
import type { Block } from "@repo/core";
import { COMPOSITE_KIND, TEXT_KIND, textState } from "@repo/core";
import { schemaMessage } from "@/lib/schema-error";
import { MediaText } from "@/components/media-text";
import type { FileState, MetricState } from "./kinds";
import {
  FILE_KIND,
  fileState,
  kinds,
  METRIC_KIND,
  metricState,
} from "./kinds";
import type { MediaState } from "./media";
import {
  MEDIA_KIND,
  mediaInfo,
  mediaName,
  mediaSrc,
  mediaState,
} from "./media";

/** One editable entry of a block's state, offered in its actions menu. */
export type BlockField = {
  /** Key in `block.data` that the edit writes. */
  name: string;
  label: string;
  value: string;
};

/**
 * How a kind renders its row. The rail itself is uniform — every block is one
 * solid node — so a kind only decides what its state looks like as content.
 *
 * Each view parses `block.data` through its kind's schema, so components
 * receive complete state and never guess at missing fields.
 *
 * Rows are not limited to one line: this is a GUI, so a kind renders its
 * content inline. Beyond that a kind may add editable `fields`, a full-size
 * `Preview`, and a `raw` URL the underlying file can be opened at.
 */
export type BlockView = {
  Row: (props: { block: Block }) => ReactNode;
  fields?: (block: Block) => BlockField[];
  Preview?: (props: { block: Block }) => ReactNode;
  raw?: (block: Block) => string;
};

function MetricRow({ state }: { state: MetricState }) {
  const ratio = Math.min(1, state.value / state.limit);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="h-1.5 w-24 shrink-0 rounded-full bg-muted" aria-hidden>
        <span
          className="block h-full rounded-full bg-foreground/60"
          style={{ width: `${ratio * 100}%` }}
        />
      </span>
      <span className="tabular-nums text-muted-foreground">
        {state.value}/{state.limit} {state.unit}
      </span>
    </span>
  );
}

function FileRow({ state }: { state: FileState }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{state.path}</span>
      <span className="shrink-0 rounded border px-1 text-muted-foreground">
        {state.language}
      </span>
      <span className="truncate text-muted-foreground">{state.summary}</span>
    </span>
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
      <span className="shrink-0 rounded border px-1 text-muted-foreground">
        {type}
      </span>

      {type === "image" ? (
        // A media block's URI is arbitrary — any host, or a local file behind
        // the media route — so next/image, which validates src against a fixed
        // remotePatterns list, cannot serve it.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="max-h-48 w-auto shrink-0 border" />
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
      {type === "text" ? (
        <MediaText
          src={src}
          markdown={mime === "text/markdown"}
          className="pointer-events-none h-48 w-96 shrink-0 overflow-hidden"
        />
      ) : null}

      <span className="truncate">{mediaName(state.uri)}</span>
      <span className="truncate text-muted-foreground">{state.uri}</span>
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
      // eslint-disable-next-line @next/next/no-img-element
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
  if (type === "text") {
    return (
      <MediaText
        src={src}
        markdown={mime === "text/markdown"}
        className="h-[70vh] w-full overflow-auto overscroll-contain"
      />
    );
  }
  return (
    <p className="text-muted-foreground">
      no viewer for this extension — enter opens it in a new tab
    </p>
  );
}

export const blockViews: Record<string, BlockView> = {
  [TEXT_KIND]: {
    Row: ({ block }) => (
      <span className="truncate text-muted-foreground">
        {textState.parse(block.data).text}
      </span>
    ),
  },

  [COMPOSITE_KIND]: {
    Row: ({ block }) => (
      <span className="truncate text-muted-foreground italic">
        {block.children.length} nested
      </span>
    ),
  },

  [METRIC_KIND]: {
    Row: ({ block }) => <MetricRow state={metricState.parse(block.data)} />,
  },

  [FILE_KIND]: {
    Row: ({ block }) => <FileRow state={fileState.parse(block.data)} />,
  },

  [MEDIA_KIND]: {
    Row: ({ block }) => <MediaRow state={mediaState.parse(block.data)} />,
    fields: (block) => [
      { name: "uri", label: "uri", value: mediaState.parse(block.data).uri },
    ],
    Preview: ({ block }) => (
      <MediaPreview state={mediaState.parse(block.data)} />
    ),
    raw: (block) => mediaSrc(mediaState.parse(block.data).uri),
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
 * malformed block would otherwise throw through the whole page — and the store
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
 * The view a block renders through: its kind's, unless its state fails that
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
