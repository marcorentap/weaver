import type { ReactNode } from "react";
import type { Block } from "@repo/core";
import { GROUP_KIND, TEXT_KIND, textState } from "@repo/core";
import { schemaMessage } from "@/lib/schema-error";
import { readSettings } from "@/lib/settings";
import { READ_ONLY_TOOLS } from "@/lib/agent-events";
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
import type { IssLocationState } from "./iss";
import { ISS_LOCATION_KIND, issLocationState } from "./iss";
import type { TimerState } from "./timer";
import { TIMER_KIND, timerState } from "./timer";
import type { AgentState } from "./agent";
import { AGENT_KIND, agentState } from "./agent";
import type { ToolState } from "./tool";
import { TOOL_KIND, toolState } from "./tool";

/** One editable entry of a block's state, offered in its actions menu. */
export type BlockField = {
  /** Key in `block.data` that the edit writes. */
  name: string;
  label: string;
  value: string;
  /** What an empty `value` actually resolves to at run time — shown in the
   *  actions menu in place of a blank, and as the editor's placeholder, so
   *  an inherited default is visible instead of looking unset. */
  placeholder?: string;
  /** Content rather than a label: the editor gives it a text area where
   *  enter inserts a newline, and the row renders every line of it. */
  multiline?: boolean;
  /** `value`'s real type once parsed — a `"number"` field round-trips
   *  through `Number()` before it's written; everything else stays a
   *  string as-is. */
  type?: "number";
};

/**
 * How a kind renders its row. The rail itself is uniform — every block is one
 * solid node — so a kind only decides what its state looks like as content.
 *
 * Each view parses `block.data` through its kind's schema, so components
 * receive complete state and never guess at missing fields. `nested` is the
 * number of blocks nested directly inside this one: a block only links to
 * the first of them, so counting is the caller's job, not a view's.
 *
 * Rows are not limited to one line: this is a GUI, so a kind renders its
 * content inline. Beyond that a kind may add editable `fields`, a full-size
 * `Preview`, and a `raw` URL the underlying file can be opened at.
 */
export type BlockView = {
  Row: (props: { block: Block; nested: number }) => ReactNode;
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

function TimerRow({ state }: { state: TimerState }) {
  return (
    <span className="flex min-w-0 items-center gap-2 truncate text-muted-foreground">
      <span>
        Every {state.intervalMs}ms → {state.hook}
      </span>
      <span className="shrink-0 text-muted-foreground/60">
        {state.ticks} ticks
      </span>
    </span>
  );
}

function IssLocationRow({ state }: { state: IssLocationState }) {
  if (state.error !== null) {
    return <span className="truncate text-destructive">{state.error}</span>;
  }
  if (state.latitude === null || state.longitude === null) {
    return (
      <span className="truncate text-muted-foreground">Not fetched yet</span>
    );
  }
  return (
    <span className="truncate text-muted-foreground">
      {state.latitude.toFixed(2)}, {state.longitude.toFixed(2)}
    </span>
  );
}

function AgentRow({ state }: { state: AgentState }) {
  if (state.error !== null) {
    return <span className="truncate text-destructive">{state.error}</span>;
  }
  return (
    <span className="flex min-w-0 flex-1 items-start gap-2 text-muted-foreground">
      <span className="min-w-0 flex-1 whitespace-pre-wrap">
        {state.prompt || "(no prompt)"}
      </span>
      <span className="shrink-0 text-muted-foreground/60">
        {state.ranAt
          ? `ran ${new Date(state.ranAt).toLocaleTimeString()}`
          : "not run yet"}
      </span>
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
      {state.output ? (
        <span
          className={`min-w-0 whitespace-pre-wrap ${
            state.ok ? "text-muted-foreground" : "text-destructive"
          }`}
        >
          {state.output}
        </span>
      ) : null}
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
      {type === "image" ? (
        // A media block's URI is arbitrary — any host, or a local file behind
        // the media route — so next/image, which validates src against a fixed
        // remotePatterns list, cannot serve it.
        // `max-height` alone leaves an intrinsically small image (an icon-size
        // svg, say) at its natural size instead of filling the row; a fixed
        // `h-48` plus `object-contain` scales every image up or down to it.
        // eslint-disable-next-line @next/next/no-img-element
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
      {type === "text" ? (
        <MediaText
          src={src}
          markdown={mime === "text/markdown"}
          className="pointer-events-none h-48 w-96 shrink-0 overflow-hidden"
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
      No viewer for this extension. Press enter to open in new tab
    </p>
  );
}

export const blockViews: Record<string, BlockView> = {
  [TEXT_KIND]: {
    // Wraps and keeps its newlines instead of clipping to one line: a text
    // block is content, not a label, and a truncated one is unreadable.
    Row: ({ block }) => (
      <span className="min-w-0 flex-1 whitespace-pre-wrap text-muted-foreground">
        {textState.parse(block.data).text}
      </span>
    ),
    fields: (block) => [
      {
        name: "text",
        label: "text",
        value: textState.parse(block.data).text,
        multiline: true,
      },
    ],
  },

  [GROUP_KIND]: {
    Row: ({ nested }) => (
      <span className="truncate text-muted-foreground italic">
        {nested} nested
      </span>
    ),
  },

  [METRIC_KIND]: {
    Row: ({ block }) => <MetricRow state={metricState.parse(block.data)} />,
    fields: (block) => {
      const state = metricState.parse(block.data);
      return [
        { name: "value", label: "value", value: String(state.value), type: "number" },
        { name: "limit", label: "limit", value: String(state.limit), type: "number" },
        { name: "unit", label: "unit", value: state.unit },
      ];
    },
  },

  [FILE_KIND]: {
    Row: ({ block }) => <FileRow state={fileState.parse(block.data)} />,
    fields: (block) => {
      const state = fileState.parse(block.data);
      return [
        { name: "path", label: "path", value: state.path },
        { name: "language", label: "language", value: state.language },
        { name: "summary", label: "summary", value: state.summary },
      ];
    },
  },

  [MEDIA_KIND]: {
    Row: ({ block }) => <MediaRow state={mediaState.parse(block.data)} />,
    fields: (block) => [
      { name: "uri", label: "URI", value: mediaState.parse(block.data).uri },
    ],
    Preview: ({ block }) => (
      <MediaPreview state={mediaState.parse(block.data)} />
    ),
    raw: (block) => mediaSrc(mediaState.parse(block.data).uri),
  },

  [TIMER_KIND]: {
    Row: ({ block }) => <TimerRow state={timerState.parse(block.data)} />,
    fields: (block) => [
      {
        name: "intervalMs",
        label: "interval (ms)",
        value: String(timerState.parse(block.data).intervalMs),
        type: "number",
      },
    ],
  },

  [ISS_LOCATION_KIND]: {
    Row: ({ block }) => (
      <IssLocationRow state={issLocationState.parse(block.data)} />
    ),
  },

  [AGENT_KIND]: {
    Row: ({ block }) => <AgentRow state={agentState.parse(block.data)} />,
    fields: (block) => {
      const state = agentState.parse(block.data);
      const fallback = readSettings().aiDefaultModel;
      return [
        {
          name: "prompt",
          label: "prompt",
          value: state.prompt,
          multiline: true,
        },
        {
          name: "model",
          label: "model",
          value: state.model,
          // A blank field means "use the settings default", so show which
          // model that actually is rather than nothing at all.
          placeholder: fallback || "no default model — see settings",
        },
        {
          name: "tools",
          label: "tools",
          value: state.tools,
          placeholder: READ_ONLY_TOOLS.join(", "),
        },
      ];
    },
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
