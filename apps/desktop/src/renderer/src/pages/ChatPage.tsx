import { Fragment, type ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { Block, BlockGraph, BlockId, Position } from "@repo/core";
import { childIds, GROUP_KIND, lastChildId, TEXT_KIND, textState, topLevelBlockIds } from "@repo/core";
import type { BlockInput } from "@repo/store";
import type { ChatSessionSummary, LoadGraphResult } from "@shared/ipc-contract.js";
import type { BlockField, BlockView } from "@/blocks/views";
import { ShellHeader } from "@/components/app-shell";
import { viewFor } from "@/blocks/views";
import { FieldEditor } from "@/components/field-editor";
import { Gutter } from "@/components/gutter";
import type { KeyMenuItem } from "@/components/key-menu";
import { KeyMenu } from "@/components/key-menu";
import { ModalFrame } from "@/components/modal-frame";
import { useKeyLayer } from "@/lib/keymap";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import type { ChatNode } from "@/lib/graph-view";
import { chatNodes } from "@/lib/graph-view";
import { scheduledHooks } from "@/lib/live-graph";
import { getLiveGraph, dropLiveGraph } from "@/lib/live-graph-registry";
import { kinds } from "@shared/blocks/kinds.js";
import { TOOL_KIND, toolState, USER_KIND } from "@plugins/rich-media";
import { MEDIA_KIND, mediaState } from "@/blocks/media";

/** Which modal popup, if any, sits above chat's normal mode. */
type Popup =
  | { kind: "actions" }
  | { kind: "selection" }
  | { kind: "sessions" }
  | { kind: "preview" }
  | { kind: "field"; field: BlockField }
  | { kind: "labelField" }
  | { kind: "configure" }
  | { kind: "callHook"; hook: string }
  | { kind: "createKind" }
  | { kind: "createUser" }
  | { kind: "createLabel" }
  | { kind: "createSession" }
  | { kind: "renameSession" }
  | null;

/** One rendered row of the unfolded tree; media rows are taller than a line. */
type Row = {
  block: Block;
  depth: number;
  /** Row index of the enclosing block, so `←` can climb out of a group. */
  parent: number | null;
  /** How many blocks are nested directly inside this one. */
  nested: number;
  expanded: boolean;
};

const INDENT_REM = 1;

function flatten(
  nodes: ChatNode[],
  expanded: ReadonlySet<BlockId>,
  depth = 0,
  parent: number | null = null,
  rows: Row[] = [],
): Row[] {
  for (const node of nodes) {
    const index = rows.length;
    const open = expanded.has(node.block.id);
    rows.push({
      block: node.block,
      depth,
      parent,
      nested: node.children.length,
      expanded: open,
    });
    if (open) flatten(node.children, expanded, depth + 1, index, rows);
  }
  return rows;
}

/** The block id of `row`'s enclosing container, or null for top-level. */
function containerOf(rows: Row[], row: Row | undefined): BlockId | null {
  if (!row) return null;
  return row.parent === null ? null : (rows[row.parent]?.block.id ?? null);
}

/**
 * Where a new block goes for the gap before `rows[gap]` (`gap === rows.length`
 * means after the last row). It lands right after the row above the gap, in
 * that row's own chain. So inserting right after a group's last child nests
 * the new block there too rather than popping back out to top-level, and
 * inserting after an unfolded group appends after the whole group rather
 * than into it. With no row above, the gap at the very top, it becomes the
 * first block of whatever chain the row below belongs to.
 */
function computeInsertion(rows: Row[], gap: number): Position {
  const before = rows[gap - 1];
  if (before) {
    return { parentId: containerOf(rows, before), afterId: before.block.id };
  }
  return { parentId: containerOf(rows, rows[gap]), afterId: null };
}

/** A hover-revealed icon between rows (and at the very top/bottom of the
 *  list) that inserts a new block at that exact gap. Zero height in flow.
 *  The button overlays the seam between rows instead of pushing them
 *  apart, so nothing shifts just because a gap exists. */
function InsertGap({ onClick }: { onClick: () => void }) {
  return (
    <div className="relative h-0">
      <button
        type="button"
        onClick={onClick}
        aria-label="Insert block here"
        className="absolute right-3 top-0 z-10 -translate-y-1/2 rounded border border-white bg-background p-0.5 text-muted-foreground opacity-0 hover:text-foreground hover:opacity-100 focus-visible:opacity-100"
      >
        <Plus className="size-3" />
      </button>
    </div>
  );
}

/** Label color by who produced a block. A person typing it (`user` kind),
 *  or an inference run appending it after the block that asked, a reply's
 *  own prose or a tool call it made along the way. Anything else (a media
 *  block someone added by hand) stays uncolored. */
function originClass(block: Block): string {
  if (block.label === "error") return "text-destructive";
  if (block.kind === USER_KIND) return "text-blue-400";
  if (block.kind === TOOL_KIND || block.label === "assistant") {
    return "text-emerald-400";
  }
  return "";
}

/** What "Copy content" (`y`) means for a kind, or null for a kind with no
 *  single string worth copying; "Copy ID" already covers the block itself. */
function copyableContent(block: Block): { label: string; value: string } | null {
  switch (block.kind) {
    case TEXT_KIND:
    case USER_KIND:
      return { label: "Copy content", value: textState.parse(block.data).text };
    case MEDIA_KIND:
      return { label: "Copy URI", value: mediaState.parse(block.data).uri };
    case TOOL_KIND:
      return { label: "Copy output", value: toolState.parse(block.data).output };
    default:
      return null;
  }
}

/** Tall content is clipped to this many lines until it is unhidden. Rows are
 *  `text-xs`, whose line height is exactly `1rem`, so this is also its
 *  height in rem. */
const CLIP_LINES = 12;

function BlockRow({
  row,
  selected,
  inSelection,
  line,
  running,
  gutter,
  shown,
  onSelect,
  onToggle,
  onShow,
}: {
  row: Row;
  selected: boolean;
  /** Whether this row falls inside an active visual selection (`v`),
   *  cursor row included. */
  inSelection: boolean;
  /** Number to show in the gutter, or null when line numbers are off. */
  line: number | null;
  /** Whether this block has a hook in flight right now. */
  running: boolean;
  /** Whether the gutter column is enabled at all (hidden pre-hydration). */
  gutter: boolean;
  /** Whether this row's content is shown in full rather than clipped. */
  shown: boolean;
  /** Click anywhere on the row to select it and open its actions, like `enter`. */
  onSelect: () => void;
  /** Click the chevron to fold or unfold, without opening actions. */
  onToggle: () => void;
  /** Click the "more lines" marker to unhide the rest of this row. */
  onShow: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** Lines the clip is currently hiding, measured rather than guessed.
   *  Markdown, images and fetched text all settle after the first render. */
  const [clipped, setClipped] = useState(0);
  const view = viewFor(row.block);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    const box = content.current;
    // Nothing to measure once the row is shown in full; the stale count is
    // simply not rendered, and a re-hide measures again.
    if (!box || shown) return;
    const measure = () => {
      const height = parseFloat(getComputedStyle(box).lineHeight) || 16;
      // The box itself reports growth it never clips (markdown, images).
      let over = box.scrollHeight - box.clientHeight;
      // A self-clipping content card (code wall, tool output) is capped at
      // the row height so its border stays whole, hiding its overflow from
      // the box; each such card reports its own hidden text.
      for (const card of box.querySelectorAll<HTMLElement>("[data-clip]")) {
        over = Math.max(over, card.scrollHeight - card.clientHeight);
      }
      setClipped(over > 1 ? Math.max(1, Math.round(over / height)) : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    // A media file's text arrives long after mount, so watch for cards (and
    // new content) and re-arm the observer against them.
    const reobserve = () => {
      for (const card of box.querySelectorAll<HTMLElement>("[data-clip]")) {
        observer.observe(card);
      }
    };
    reobserve();
    const added = new MutationObserver(reobserve);
    added.observe(box, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      added.disconnect();
    };
  }, [shown]);

  return (
    <div
      ref={ref}
      aria-selected={selected}
      aria-expanded={row.nested > 0 ? row.expanded : undefined}
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer items-start gap-3 border-l-2 py-1 pl-1 pr-3",
        selected
          ? "border-foreground/60 bg-muted"
          : inSelection
            ? "border-foreground/30 bg-muted/40"
            : "border-transparent",
      )}
    >
      <Gutter line={line} show={gutter} current={selected} />
      <span
        // Indent eats into this column, so it is wide enough for a couple of
        // nesting levels before labels start truncating.
        className="flex w-52 shrink-0 items-center gap-1"
        style={{ paddingLeft: `${row.depth * INDENT_REM}rem` }}
      >
        {row.nested > 0 ? (
          <button
            type="button"
            aria-label={row.expanded ? "Collapse" : "Expand"}
            // The row itself is the actions target, so the chevron has to keep
            // its click to itself. It is padded well past the glyph, since a
            // 12px arrow is a miserable click target.
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            className="-my-1 shrink-0 p-1 text-muted-foreground hover:text-foreground"
          >
            {row.expanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        ) : (
          // Same box as the button, negative margin included, or childless
          // rows sit 8px taller than the rest.
          <span className="-my-1 size-6 shrink-0" />
        )}
        <span className={cn("min-w-0 truncate font-medium", originClass(row.block))}>
          {row.block.label}
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start">
        <div
          ref={content}
          className={cn("flex w-full", shown ? "" : "overflow-hidden")}
          style={shown ? undefined : { maxHeight: `${CLIP_LINES}rem` }}
        >
          <view.Row block={row.block} nested={row.nested} running={running} />
        </div>
        {!shown && clipped > 0 ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onShow();
            }}
            className="text-muted-foreground/60 hover:text-foreground"
          >
            truncated
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * A kind's full-size presentation, as its own mode.
 *
 * If the preview contains a player, it takes DOM focus. The keymap only
 * preventDefaults keys a layer binds, so space, arrows and volume keys reach
 * the element natively. Chat's own arrows are unreachable anyway while this
 * modal layer is on top, which is why focus is scoped to here and inline
 * row players are left unfocused.
 */
function PreviewModal({
  block,
  raw,
  onClose,
  children,
}: {
  block: Block;
  /** Computes the underlying file's URL, if the kind exposes one. Lazy, so a
   * kind whose "file" is really an object URL (built fresh from a block's
   * own text, not a real address) only creates one when actually opened,
   * instead of leaking one on every render this modal stays open for. */
  raw: (() => string) | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [player, setPlayer] = useState(false);

  useEffect(() => {
    const media = body.current?.querySelector<HTMLMediaElement>("video, audio");
    if (!media) return;
    media.focus();
    setPlayer(true);
  }, []);

  /** One line of vim-style scroll, in pixels. A reasonable step at the
   * rail's text-xs scale rather than a measured line height, since the
   * scrollable element varies (a `<pre>` for code, a markdown `<div>`). */
  const scrollBy = (lines: number) => {
    const scroller = body.current?.querySelector<HTMLElement>(".overflow-auto");
    scroller?.scrollBy({ top: lines * 20 });
  };

  useKeyLayer({
    id: "preview",
    modal: true,
    bindings: [
      ...(raw
        ? [
            {
              keys: ["Enter"],
              help: { keys: "enter", label: "Open file in a new tab" },
              run: () => {
                const url = raw();
                window.open(url, "_blank", "noopener,noreferrer");
                // Object URLs only. Give the new tab a moment to load the
                // blob before releasing it. A real URL has nothing to
                // revoke.
                if (url.startsWith("blob:")) {
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }
              },
            },
          ]
        : []),
      // No-ops when nothing in the preview scrolls (an image, a player).
      // The player already owns arrow keys, so j/k stay clear too.
      {
        keys: ["j"],
        help: { keys: "j / k", label: "Scroll" },
        run: (count) => scrollBy(count ?? 1),
      },
      {
        keys: ["k"],
        run: (count) => scrollBy(-(count ?? 1)),
      },
      {
        keys: ["Escape", "q"],
        help: { keys: "esc / q", label: "Close" },
        run: onClose,
      },
    ],
    // Owned by the focused player, not by the keymap.
    docs: player
      ? [
          { keys: "space", label: "Play / pause" },
          { keys: "← / →", label: "Seek" },
          { keys: "↑ / ↓", label: "Volume" },
        ]
      : [],
  });

  return (
    <ModalFrame
      label={`Preview ${block.label}`}
      title={block.label}
      meta={block.kind}
      size="lg"
      onClose={onClose}
    >
      <div ref={body} className="flex items-center justify-center p-3">
        {children}
      </div>
    </ModalFrame>
  );
}

/** Closes over a view's `raw` getter without a non-null assertion. The
 * `view.raw` truthy check and the call both happen inside one function,
 * where TypeScript narrows it, instead of across a JSX ternary and a
 * separately-created arrow function where it cannot. */
function previewRaw(
  view: BlockView,
  block: Block,
): (() => string) | undefined {
  const getRaw = view.raw;
  return getRaw ? () => getRaw(block) : undefined;
}

function ChatView({
  sessions,
  session,
  initialGraph,
  refetchSessions,
}: {
  sessions: ChatSessionSummary[];
  session: { id: string; name: string } | null;
  initialGraph: BlockGraph;
  /** Re-fetches the sessions list (and the current session's own name)
   *  after a mutation that changes them in place without navigating, a
   *  rename. Create/delete already navigate to a different `?session=`,
   *  which `ChatPage`'s own effect picks up and reloads for on its own, so
   *  those two never need to call this. */
  refetchSessions: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [, startTransition] = useTransition();
  const [cursor, setCursor] = useState(0);
  /** Whether the cursor sat on the last row as of the last completed
   *  render, and how many rows there were then. An append (a streaming
   *  inference reply, a hook's own result) can tell "was following the
   *  tail" from "was parked somewhere else" and only auto-advance the
   *  former. */
  const lastRowCountRef = useRef(0);
  const wasAtEndRef = useRef(true);
  /** Row index the current visual selection (`v`) is anchored to, or null
   *  when no selection is active. The other end is always the live
   *  cursor, so `j`/`k`/`G`/`gg` extend the selection for free. */
  const [visualAnchor, setVisualAnchor] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<BlockId>>(
    () => new Set(),
  );
  /** Rows whose clipped content has been unhidden, and the override that
   *  unhides every row at once, `ctrl+o`. */
  const [shown, setShown] = useState<ReadonlySet<BlockId>>(() => new Set());
  const [showEverything, setShowEverything] = useState(false);
  const [popup, setPopup] = useState<Popup>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Where a pending "new block" flow will land, chosen before the kind and
   *  label are; `pendingKind` is the kind picked in the step after. */
  const [creating, setCreating] = useState<Position | null>(null);
  const [pendingKind, setPendingKind] = useState<string | null>(null);
  /** A block to select once it appears in `rows`. It may not exist there
   *  the same render it lands, if its container was not already expanded.
   *  `openActions` distinguishes "just created, show its actions" (create
   *  flow) from "just moved, only follow the cursor" (move/nest keys). */
  const [pendingFocus, setPendingFocus] = useState<
    { id: BlockId; openActions: boolean; runInference?: boolean } | null
  >(null);
  const { settings, hydrated } = useSettings();

  // ---- Live graph state --------------------------------------------------
  // The client owns the graph from here on. A hook (a timer's tick, an ISS
  // fetch, an inference run, this file has no idea which) mutates it and
  // notifies subscribers immediately, so it lands on screen the instant it
  // resolves, not on whatever cadence a poll happened to run at. The engine
  // itself lives in a module-scope registry keyed by session id, not in
  // `useState`. This component (and everything under `/chat`) unmounts on a
  // plain tab switch, and a `useState` engine, along with any run still
  // streaming into it, would go with it. `initialGraph` only seeds a
  // session's engine the first time it is asked for; every later mount
  // reattaches to whatever the registry already has.
  const engine = getLiveGraph(session?.id ?? "none", initialGraph);
  const { graph, dirty, savedAt, running } = useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
    engine.getSnapshot,
  );
  const liveNodes = chatNodes(graph);

  // One real `setInterval` per block asking for one, at its own configured
  // interval. This is what makes an update land within a millisecond of
  // when it fires, instead of at the next poll. Entirely kind-agnostic.
  // `scheduledHooks` just asks every block's kind whether it wants this,
  // the same way for all of them. Restarts (all of them, cheap for a
  // handful) whenever any schedule actually changes.
  const scheduleSignature = scheduledHooks(graph)
    .map((entry) => `${entry.id}:${entry.intervalMs}:${entry.hook}`)
    .sort()
    .join("|");

  useEffect(() => {
    const timers = scheduledHooks(engine.getSnapshot().graph).map((entry) =>
      setInterval(() => {
        engine.runHook(entry.id, entry.hook).catch((error) =>
          console.error(
            `scheduled hook "${entry.hook}" on ${entry.id} failed:`,
            error,
          ),
        );
      }, entry.intervalMs),
    );
    return () => timers.forEach(clearInterval);
  }, [scheduleSignature, engine]);

  // ---- Persistence: autosave + manual save -------------------------------
  // A fixed 3s cadence, not a debounce. A timer ticking every 2s would keep
  // resetting a debounce and never actually save. `performSaveRef` lets that
  // interval stay mounted for the component's life while always calling the
  // latest closure (current `session`, current engine).
  const performSave = useCallback(async (): Promise<void> => {
    if (!session) return;
    const result = await window.api.chat.saveGraph(
      session.id,
      engine.toBlockInputs(),
    );
    if (result.error) {
      engine.markSaveFailed();
      console.error("save failed:", result.error);
      return;
    }
    engine.markSaved();
  }, [session, engine]);

  const performSaveRef = useRef(performSave);
  useEffect(() => {
    performSaveRef.current = performSave;
  }, [performSave]);

  useEffect(() => {
    const id = setInterval(() => {
      if (engine.getSnapshot().dirty) void performSaveRef.current();
    }, 3000);
    return () => clearInterval(id);
  }, [engine]);

  const rows = flatten(liveNodes, expanded);
  // Follows a block to its new row the instant it shows up in `rows`.
  // Immediately for a top-level block, one render later for a nested one,
  // since expanding its container also happens during this same "adjust
  // state while rendering" pass. Guarded by clearing `pendingFocus` once
  // applied, so this cannot loop.
  if (pendingFocus) {
    const i = rows.findIndex((entry) => entry.block.id === pendingFocus.id);
    if (i !== -1) {
      setCursor(i);
      if (pendingFocus.openActions) setPopup({ kind: "actions" });
      if (pendingFocus.runInference) void runInference(pendingFocus.id);
      setPendingFocus(null);
    }
  }
  const index = Math.min(cursor, Math.max(rows.length - 1, 0));
  const row = rows[index];
  const view = row ? viewFor(row.block) : null;

  // The selection spans the anchor to the live cursor, inclusive of both.
  // Clamped in case a block vanished (deleted, container collapsed) since
  // the anchor was dropped.
  const selectionRange: [number, number] | null =
    visualAnchor === null
      ? null
      : [
          Math.min(Math.min(visualAnchor, rows.length - 1), index),
          Math.max(Math.min(visualAnchor, rows.length - 1), index),
        ];
  const selectedRows = selectionRange
    ? rows.slice(selectionRange[0], selectionRange[1] + 1)
    : row
      ? [row]
      : [];

  // Rides the tail as it grows. A block appending (streaming inference, a
  // hook's own result) while the cursor sat on the last row moves the
  // cursor along to the new last row, rather than stranding it on what is
  // now a mid-list row. Refs, not render-phase reads, since the compiler
  // requires render to stay pure. Both effects run after commit instead.
  useEffect(() => {
    if (rows.length > lastRowCountRef.current && wasAtEndRef.current) {
      setCursor(rows.length - 1);
    }
    lastRowCountRef.current = rows.length;
  }, [rows.length]);
  useEffect(() => {
    wasAtEndRef.current = rows.length > 0 && index === rows.length - 1;
  });

  /** Whether the gutter column is live at all (hidden before hydration so the
   *  stored preference never flashes in with the wrong mode). */
  const gutter = hydrated && settings.lineNumber !== "off";
  /** Number for a row. Absolute is its 1-based position; relative is its
   *  distance from the cursor, except the selected row, which reads its own
   *  1-based position instead of the useless anchor `0`. */
  const lineNumber = (i: number): number | null =>
    gutter
      ? settings.lineNumber === "relative" && i !== index
        ? Math.abs(i - index)
        : i + 1
      : null;

  const move = (delta: number) => {
    if (rows.length === 0) return;
    setCursor(Math.min(Math.max(index + delta, 0), rows.length - 1));
  };

  /** Jumps to the 1-based line number shown in the gutter, vim's `G`,
   *  clamped to the row range instead of no-oping past either end. */
  const jump = (line: number) => {
    if (rows.length === 0) return;
    setCursor(Math.min(Math.max(line - 1, 0), rows.length - 1));
  };

  const setOpen = (id: BlockId, open: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  /** Unfold, or step into the group once it is already unfolded. */
  const expand = () => {
    if (!row) return;
    if (row.nested > 0 && !row.expanded) setOpen(row.block.id, true);
    else if (row.expanded) move(1);
  };

  /** Fold, or climb out to the enclosing block when there is nothing to fold. */
  const collapse = () => {
    if (!row) return;
    if (row.expanded) setOpen(row.block.id, false);
    else if (row.parent !== null) setCursor(row.parent);
  };

  /** Starts the "new block" flow for the gap before `rows[gap]`. */
  const beginCreate = (gap: number) => {
    setError(null);
    setCreating(computeInsertion(rows, gap));
    setPopup({ kind: "createKind" });
  };

  /** Starts the "new user block" flow for the gap before `rows[gap]`. Same
   *  gap semantics as `beginCreate`, fixed to `USER_KIND` and skipping the
   *  kind picker, since `i`/`I` mean "write a message", not "pick a kind". */
  const beginCreateUser = (gap: number) => {
    setError(null);
    setCreating(computeInsertion(rows, gap));
    setPopup({ kind: "createUser" });
  };

  /** The chain a container holds, in order. The top-level chain for null. */
  const siblingsOf = (containerId: BlockId | null) =>
    containerId === null ? topLevelBlockIds(graph) : childIds(graph, containerId);

  /** Relinks `id` at `at` locally and on the server, then follows it to its
   *  new row. The single path behind `J`/`K` and `>`/`<`. Every structural
   *  edit is the same operation with a different target position. */
  const relocate = (id: BlockId, at: Position) => {
    if (!session) return;
    engine.moveBlock(id, at);
    if (at.parentId) setOpen(at.parentId, true);
    setPendingFocus({ id, openActions: false });
    startTransition(() => {
      void window.api.chat.moveChatBlock(session.id, id, at);
    });
  };

  /** `J`/`K`: reorders the selected block within its own chain, past the
   *  neighbor in that direction. No-ops at either end. */
  const moveWithinSiblings = (direction: 1 | -1) => {
    if (!row) return;
    const container = containerOf(rows, row);
    const siblings = siblingsOf(container);
    const at = siblings.indexOf(row.block.id);
    const target = at + direction;
    if (at === -1 || target < 0 || target >= siblings.length) return;
    // Down means landing after the next sibling; up means landing before the
    // previous one, which is "after the one before it", or first in the
    // chain when there is nothing before it.
    const afterId =
      direction === 1 ? (siblings[target] as BlockId) : (siblings[target - 1] ?? null);
    relocate(row.block.id, { parentId: container, afterId });
  };

  /** `>`: nests the selected block one level deeper, as the last child of
   *  the block before it in its own chain. No-op if there is nothing before
   *  it (already first among its siblings). */
  const nest = () => {
    if (!row) return;
    const container = containerOf(rows, row);
    const siblings = siblingsOf(container);
    const at = siblings.indexOf(row.block.id);
    if (at < 1) return;
    const target = siblings[at - 1] as BlockId;
    relocate(row.block.id, {
      parentId: target,
      afterId: lastChildId(graph, target),
    });
  };

  /** `<`: unnests the selected block one level, making it the block right
   *  after its former container instead of the last thing inside it. No-op
   *  if already top-level. */
  const unnest = () => {
    if (!row || row.parent === null) return;
    const container = rows[row.parent] as Row;
    relocate(row.block.id, {
      parentId: containerOf(rows, container),
      afterId: container.block.id,
    });
  };

  /**
   * The global "run inference" action. Any block can anchor a run, of any
   * kind. The engine owns the actual prompt assembly, streaming, and result
   * blocks (`lib/live-graph`'s `runInference`). It lives there rather than
   * here so a run survives this component unmounting mid-stream, e.g. a tab
   * switch away from chat and back.
   */
  function runInference(id: BlockId): Promise<void> {
    if (!session) return Promise.resolve();
    const { aiEndpoint, aiApiKey, aiDefaultModel } = settings;
    return engine.runInference(id, {
      endpoint: aiEndpoint,
      apiKey: aiApiKey,
      model: aiDefaultModel,
    });
  }

  useKeyLayer({
    id: "chat",
    bindings: [
      {
        keys: ["ArrowDown", "j"],
        help: { keys: "↓ / j / <n>j", label: "Next block, <n> at a time" },
        run: (count = 1) => move(count),
      },
      {
        keys: ["ArrowUp", "k"],
        help: { keys: "↑ / k / <n>k", label: "Previous block, <n> at a time" },
        run: (count = 1) => move(-count),
      },
      {
        keys: ["ArrowRight", "l"],
        help: { keys: "→ / l", label: "Open nested contexts, then step in" },
        run: expand,
      },
      {
        keys: ["ArrowLeft", "h"],
        help: { keys: "← / h", label: "Close nested contexts, then step out" },
        run: collapse,
      },
      {
        keys: ["J"],
        help: { keys: "J", label: "Move block down" },
        run: () => moveWithinSiblings(1),
      },
      {
        keys: ["K"],
        help: { keys: "K", label: "Move block up" },
        run: () => moveWithinSiblings(-1),
      },
      {
        keys: [">"],
        help: { keys: ">", label: "Nest under previous block" },
        run: nest,
      },
      {
        keys: ["<"],
        help: { keys: "<", label: "Unnest from parent block" },
        run: unnest,
      },
      {
        keys: ["Enter"],
        help: { keys: "enter", label: "Actions for selected block(s)" },
        run: () => {
          if (visualAnchor !== null) setPopup({ kind: "selection" });
          else if (row) setPopup({ kind: "actions" });
        },
      },
      {
        keys: ["v"],
        help: { keys: "v", label: "Toggle visual selection" },
        run: () =>
          setVisualAnchor((current) => (current === null ? index : null)),
      },
      {
        // Undocumented: this exists only to stop the browser's default
        // page-down-on-space, not to bind a feature to the key.
        keys: [" "],
        run: () => {},
      },
      {
        keys: ["Escape"],
        help: { keys: "esc", label: "Cancel visual selection" },
        run: () => setVisualAnchor(null),
      },
      {
        keys: ["ctrl+c"],
        help: { keys: "ctrl+c", label: "Stop the nearest running inference" },
        run: () => {
          // A run's replies are siblings after the anchoring block, not
          // descendants, so "up" means earlier in the rendered chain, not
          // parents. Scan backward from the cursor for the closest block
          // with a run in flight and stop it.
          const { running } = engine.getSnapshot();
          for (let i = index; i >= 0; i--) {
            const target = rows[i]?.block;
            if (target && running.has(target.id)) {
              engine.abortRun(target.id);
              break;
            }
          }
        },
      },
      {
        keys: ["s"],
        help: { keys: "s", label: "Recent sessions" },
        run: () => setPopup({ kind: "sessions" }),
      },
      {
        keys: ["o"],
        help: { keys: "o", label: "Insert block after" },
        run: () => beginCreate(row ? index + 1 : 0),
      },
      {
        keys: ["O"],
        help: { keys: "O", label: "Insert block before" },
        run: () => beginCreate(row ? index : 0),
      },
      {
        keys: ["i"],
        help: { keys: "i", label: "Write a message after, run inference" },
        run: () => beginCreateUser(row ? index + 1 : 0),
      },
      {
        keys: ["I"],
        help: { keys: "I", label: "Write a message before, run inference" },
        run: () => beginCreateUser(row ? index : 0),
      },
      {
        keys: ["G"],
        help: { keys: "G / <n>G", label: "Jump to last block / line <n>" },
        run: (count) => jump(count ?? rows.length),
      },
      {
        chord: ["g", "g"],
        help: { keys: "gg", label: "Jump to first block" },
        run: () => jump(1),
      },
      {
        keys: ["ctrl+o"],
        help: { keys: "ctrl+o", label: "Show or hide clipped content" },
        run: () => {
          const next = !showEverything;
          setShowEverything(next);
          // Hiding again drops the rows unhidden one at a time too, so the
          // key is a real toggle rather than a one-way door.
          if (!next) setShown(new Set());
        },
      },
    ],
  });

  const openField = (field: BlockField) => {
    setError(null);
    setPopup({ kind: "field", field });
  };

  const saveField = async (field: BlockField, value: string) => {
    if (!session || !row) return;
    setSaving(true);
    const coerced = field.type === "number" ? Number(value) : value;
    const result = await window.api.chat.updateBlockField(
      session.id,
      row.block.id,
      field.name,
      coerced,
    );
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    // The main process already validated this against the kind's schema, so
    // it is safe to reflect locally without waiting on a round trip back
    // down.
    engine.updateField(row.block.id, field.name, coerced);
    setPopup(null);
  };

  /** Renames the selected block's label in place. The label is a top-level
   *  field, not part of `data`, so it gets its own persist call and reflects
   *  locally through `engine.updateLabel`. */
  const renameBlock = async (label: string) => {
    if (!session || !row) return;
    const trimmed = label.trim();
    if (!trimmed) {
      setError("label cannot be empty");
      return;
    }
    if (trimmed === row.block.label) {
      setPopup(null);
      return;
    }
    setSaving(true);
    const result = await window.api.chat.updateBlockLabel(
      session.id,
      row.block.id,
      trimmed,
    );
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    engine.updateLabel(row.block.id, trimmed);
    setPopup(null);
  };

  /** Calls a callable directly from the configure menu. `argText` is
   *  optional JSON, parsed here so a malformed argument surfaces before the
   *  hook ever runs instead of failing inside it. */
  const runCallHook = (hook: string, argText: string) => {
    if (!row) return;
    const trimmed = argText.trim();
    let arg: unknown;
    if (trimmed) {
      try {
        arg = JSON.parse(trimmed);
      } catch {
        setError("Argument must be valid JSON");
        return;
      }
    }
    setError(null);
    setPopup(null);
    void engine.runHook(row.block.id, hook, arg);
  };

  /** Persists the block picked in `createKind`/`createLabel`, then selects
   *  it once it is visible (see the `pendingSelect` effect above). */
  const createBlock = async (label: string) => {
    if (!session || !creating || !pendingKind) return;
    const kindDef = kinds[pendingKind];
    if (!kindDef) return;
    setSaving(true);
    const input: BlockInput = {
      id: crypto.randomUUID(),
      kind: pendingKind,
      label,
      createdAt: Date.now(),
      data: kindDef.defaults ?? {},
    };
    const result = await window.api.chat.createChatBlock(
      session.id,
      input,
      creating,
    );
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    engine.addBlock(
      {
        id: input.id,
        kind: input.kind,
        label: input.label,
        createdAt: input.createdAt,
        modifiedAt: Date.now(),
        next: null,
        children: null,
        data: input.data ?? {},
      },
      creating,
    );
    if (creating.parentId) setOpen(creating.parentId, true);
    setPendingFocus({ id: input.id, openActions: true });
    setCreating(null);
    setPendingKind(null);
    setPopup(null);
  };

  /** Persists the `i`/`I` flow's message as a `user` block, then immediately
   *  runs inference on it once it is visible. That is the whole point of
   *  typing a message rather than opening its actions to pick something
   *  to do. */
  const createUserBlock = async (text: string) => {
    if (!session || !creating) return;
    setSaving(true);
    const input: BlockInput = {
      id: crypto.randomUUID(),
      kind: USER_KIND,
      label: "user",
      createdAt: Date.now(),
      data: { text },
    };
    const result = await window.api.chat.createChatBlock(
      session.id,
      input,
      creating,
    );
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    engine.addBlock(
      {
        id: input.id,
        kind: input.kind,
        label: input.label,
        createdAt: input.createdAt,
        modifiedAt: Date.now(),
        next: null,
        children: null,
        data: input.data ?? {},
      },
      creating,
    );
    if (creating.parentId) setOpen(creating.parentId, true);
    setPendingFocus({ id: input.id, openActions: false, runInference: true });
    setCreating(null);
    setPopup(null);
  };

  /** Persists a new session, then switches to it. Mirrors the recent-
   *  sessions `run` below, just against a graph that did not exist yet.
   *  Navigating to the new `?session=` is what makes `ChatPage` reload the
   *  sessions list too, so nothing here needs to refetch it directly. */
  const createSession = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("name is required");
      return;
    }
    setSaving(true);
    const result = await window.api.chat.createChatSession(trimmed);
    setSaving(false);
    if (result.error || !result.id) {
      setError(result.error ?? "failed to create session");
      return;
    }
    setPopup(null);
    setCursor(0);
    setExpanded(new Set());
    navigate(`/chat?session=${encodeURIComponent(result.id)}`);
  };

  /** Renames the open session in place. Its id, and so the URL, never
   *  changes, so nothing navigates. The sessions list (and this session's
   *  own displayed name) would otherwise go stale, so this refetches it
   *  directly instead. */
  const renameSession = async (name: string) => {
    if (!session) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("name is required");
      return;
    }
    if (trimmed === session.name) {
      setPopup(null);
      return;
    }
    setSaving(true);
    const result = await window.api.chat.renameChatSession(session.id, trimmed);
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setPopup(null);
    void refetchSessions();
  };

  /**
   * The enter menu. Whatever the kind declares (preview, editable fields,
   * configure) comes first, then the actions every block has (copy id,
   * delete) last, so a kind's own affordances read before the generic ones.
   */
  const kind = row ? kinds[row.block.kind] : undefined;

  const actions: KeyMenuItem[] =
    row && view
      ? [
          ...(view.Preview
            ? [
                {
                  label: "Preview",
                  key: "p",
                  run: () => setPopup({ kind: "preview" }),
                },
              ]
            : []),
          {
            label: "Run inference",
            key: "x",
            run: () => {
              setPopup(null);
              void runInference(row.block.id);
            },
          },
          ...(view.fields?.(row.block) ?? []).map((field, i) => ({
            // The first field is the kind's primary one, a block of URI or
            // a text block's text, so it earns the `e` key; the rest are
            // reached with arrow keys and enter.
            ...(i === 0 ? { key: "e" as const } : {}),
            label: `Edit ${field.label}`,
            // A blank field shows what it falls back to, not an empty column.
            detail: field.value || field.placeholder,
            run: () => openField(field),
          })),
          ...(kind && (kind.hooks.length > 0 || kind.callbacks.length > 0)
            ? [
                {
                  label: "Configure",
                  key: "o",
                  run: () => setPopup({ kind: "configure" }),
                },
              ]
            : []),
          ...(() => {
            const content = copyableContent(row.block);
            return content
              ? [
                  {
                    label: content.label,
                    key: "y",
                    run: () => {
                      void navigator.clipboard.writeText(content.value);
                      setPopup(null);
                    },
                  },
                ]
              : [];
          })(),
          {
            label: "Edit label",
            key: "l",
            detail: row.block.label,
            run: () => {
              setError(null);
              setPopup({ kind: "labelField" });
            },
          },
          {
            label: "Copy ID",
            key: "c",
            detail: row.block.id,
            run: () => {
              void navigator.clipboard.writeText(row.block.id);
              setPopup(null);
            },
          },
          {
            label: `Delete ${row.block.label}`,
            key: "d",
            destructive: true,
            run: () => {
              setPopup(null);
              const id = row.block.id;
              // Optimistic. Drops the row immediately, then persists the
              // delete. Everything nested inside it goes too, on both sides.
              engine.deleteBlock(id);
              if (session) {
                const graphId = session.id;
                startTransition(() => {
                  void window.api.chat.deleteChatBlock(graphId, id);
                });
              }
            },
          },
        ]
      : [];

  /**
   * The visual-selection menu (`v` then `enter`): copy every selected
   * block's content, joined, delete the whole range, or group it under a
   * new block. A kind's own actions (preview, configure, run inference)
   * stay single-block only. "Run inference on N blocks at once" has no
   * obvious single meaning yet.
   */
  const selectionActions: KeyMenuItem[] =
    selectedRows.length > 0
      ? [
          {
            label: "Copy content",
            key: "y",
            detail: `${selectedRows.length} blocks`,
            run: () => {
              const text = selectedRows
                .map((entry) => copyableContent(entry.block)?.value)
                .filter((value): value is string => value != null)
                .join("\n\n");
              void navigator.clipboard.writeText(text);
              setPopup(null);
              setVisualAnchor(null);
            },
          },
          {
            label: `Delete ${selectedRows.length} blocks`,
            key: "d",
            destructive: true,
            run: () => {
              setPopup(null);
              setVisualAnchor(null);
              const ids = selectedRows.map((entry) => entry.block.id);
              // Optimistic, same as a single delete. Each id's own nested
              // contents go with it, and an id an ancestor in this same
              // selection already dropped is just a no-op.
              for (const id of ids) engine.deleteBlock(id);
              if (session) {
                const graphId = session.id;
                startTransition(() => {
                  for (const id of ids) void window.api.chat.deleteChatBlock(graphId, id);
                });
              }
            },
          },
          {
            label: `Group ${selectedRows.length} blocks`,
            key: "g",
            run: () => {
              if (!selectionRange || !session) return;
              setPopup(null);
              setVisualAnchor(null);
              const ids = selectedRows.map((entry) => entry.block.id);
              const at = computeInsertion(rows, selectionRange[0]);
              const groupId = crypto.randomUUID();
              const graphId = session.id;
              const input: BlockInput = {
                id: groupId,
                kind: GROUP_KIND,
                label: "group",
                // `run` only executes on the key press that triggers this
                // menu action, never during render. The purity rule can't
                // see that the closure it's called in is deferred.
                // eslint-disable-next-line react-hooks/purity
                createdAt: Date.now(),
                data: {},
              };
              // Optimistic, same as delete. The group lands locally first,
              // then each selected block relocates into it in order. An
              // id an ancestor in this same selection already carried
              // along is just a redundant, harmless move.
              engine.addBlock(
                {
                  id: input.id,
                  kind: input.kind,
                  label: input.label,
                  createdAt: input.createdAt,
                  // eslint-disable-next-line react-hooks/purity -- same deferred-closure false positive as above
                  modifiedAt: Date.now(),
                  next: null,
                  children: null,
                  data: input.data ?? {},
                },
                at,
              );
              setOpen(groupId, true);
              for (const id of ids) {
                relocate(id, {
                  parentId: groupId,
                  afterId: lastChildId(engine.getSnapshot().graph, groupId),
                });
              }
              setPendingFocus({ id: groupId, openActions: false });
              startTransition(() => {
                void window.api.chat.createChatBlock(graphId, input, at);
              });
            },
          },
        ]
      : [];

  /**
   * The configure menu: a block's callables (hooks it exposes, invocable
   * directly) and callbacks (its own references to another block's hook,
   * declared by its kind's `callbacks`, a timer's target, say).
   */
  const configureItems: KeyMenuItem[] =
    row && kind
      ? [
          ...kind.hooks.map((hook) => ({
            label: `Call ${hook}`,
            detail: "Callable",
            run: () => setPopup({ kind: "callHook", hook }),
          })),
          ...kind.callbacks.flatMap((spec) => {
            const target = String(row.block.data[spec.targetField] ?? "");
            const hookName = String(row.block.data[spec.hookField] ?? "");
            const argField = spec.argField;
            const argValue = argField
              ? String(row.block.data[argField] ?? "")
              : null;
            return [
              {
                label: `${spec.label}: target`,
                detail: target,
                run: () =>
                  openField({
                    name: spec.targetField,
                    label: `${spec.label} target`,
                    value: target,
                  }),
              },
              {
                label: `${spec.label}: hook`,
                detail: hookName,
                run: () =>
                  openField({
                    name: spec.hookField,
                    label: `${spec.label} hook`,
                    value: hookName,
                  }),
              },
              ...(argField
                ? [
                    {
                      label: `${spec.label}: arg`,
                      detail: argValue || "(none)",
                      run: () =>
                        openField({
                          name: argField,
                          label: `${spec.label} argument (JSON)`,
                          value: argValue ?? "",
                        }),
                    },
                  ]
                : []),
            ];
          }),
        ]
      : [];

  /** Kinds with a schema-valid blank state. `tool` stays out: a block only
   *  becomes a tool when an inference run calls one, never by hand. */
  const createKindItems: KeyMenuItem[] = Object.values(kinds)
    .filter(
      (candidate) =>
        candidate.defaults !== null && candidate.kind !== TOOL_KIND,
    )
    .map((candidate) => ({
      label: candidate.kind,
      run: () => {
        setError(null);
        setPendingKind(candidate.kind);
        setPopup({ kind: "createLabel" });
      },
    }));

  const sessionItems: KeyMenuItem[] = [
    {
      label: "New session",
      key: "n",
      run: () => {
        setError(null);
        setPopup({ kind: "createSession" });
      },
    },
    ...(session
      ? [
          {
            label: "Rename session",
            key: "r",
            detail: session.name,
            run: () => {
              setError(null);
              setPopup({ kind: "renameSession" });
            },
          },
          {
            label: "Delete session",
            key: "d",
            destructive: true,
            run: () => {
              setPopup(null);
              const graphId = session.id;
              // Same fire-and-forget shape as deleting a block, optimistic
              // enough that there is nothing left to observe once gone.
              // Drops the cached engine too, so a session id somehow
              // reused later starts clean rather than resuming whatever
              // was last streaming into this one.
              dropLiveGraph(graphId);
              startTransition(() => {
                void window.api.chat.deleteChatSession(graphId);
                navigate("/chat");
              });
            },
          },
        ]
      : []),
    {
      label: "Save now",
      key: "s",
      detail: dirty
        ? "Unsaved changes"
        : savedAt
          ? `Saved ${new Date(savedAt).toLocaleTimeString()}`
          : "Nothing to save yet",
      run: () => {
        setPopup(null);
        void performSave();
      },
    },
    ...sessions.map((entry) => ({
      label: entry.name,
      detail: new Date(entry.modifiedAt)
        .toISOString()
        .slice(0, 16)
        .replace("T", " "),
      run: () => {
        setPopup(null);
        setCursor(0);
        setExpanded(new Set());
        navigate(`/chat?session=${encodeURIComponent(entry.id)}`);
      },
    })),
  ];

  return (
    <div className="flex min-h-full flex-col">
      <ShellHeader>
        <header className="flex items-center gap-3 border-b px-3 py-1">
          <span className="font-semibold">Chat</span>
          <span className="text-muted-foreground">
            {session ? session.name : "No session"}
          </span>
        </header>
      </ShellHeader>

      {rows.length === 0 ? (
        <>
          <InsertGap onClick={() => beginCreate(0)} />
          <p className="p-3 text-muted-foreground">
            No blocks in this session. Sending messages is not wired up yet.
          </p>
        </>
      ) : (
        <div className="py-1">
          <InsertGap onClick={() => beginCreate(0)} />
          {rows.map((entry, i) => (
            <Fragment key={entry.block.id}>
              <BlockRow
                row={entry}
                selected={i === index}
                inSelection={
                  selectionRange !== null &&
                  i >= selectionRange[0] &&
                  i <= selectionRange[1]
                }
                line={lineNumber(i)}
                running={running.has(entry.block.id)}
                shown={showEverything || shown.has(entry.block.id)}
                onShow={() =>
                  setShown((current) =>
                    new Set(current).add(entry.block.id),
                  )
                }
                gutter={gutter}
                onSelect={() => {
                  setCursor(i);
                  setPopup({ kind: "actions" });
                }}
                onToggle={() => {
                  setCursor(i);
                  setOpen(entry.block.id, !entry.expanded);
                }}
              />
              <InsertGap onClick={() => beginCreate(i + 1)} />
            </Fragment>
          ))}
        </div>
      )}

      {popup?.kind === "actions" ? (
        <KeyMenu
          id="actions"
          title={row?.block.label ?? "Block"}
          meta={row?.block.kind}
          items={actions}
          onClose={() => setPopup(null)}
        />
      ) : null}

      {popup?.kind === "selection" ? (
        <KeyMenu
          id="selection"
          title={`${selectedRows.length} blocks`}
          items={selectionActions}
          onClose={() => setPopup(null)}
        />
      ) : null}

      {popup?.kind === "sessions" ? (
        <KeyMenu
          id="sessions"
          title="Recent sessions"
          items={sessionItems}
          onClose={() => setPopup(null)}
        />
      ) : null}

      {popup?.kind === "configure" && row ? (
        <KeyMenu
          id="configure"
          title={`Configure ${row.block.label}`}
          items={configureItems}
          onClose={() => setPopup(null)}
        />
      ) : null}

      {popup?.kind === "preview" && row && view?.Preview ? (
        <PreviewModal
          block={row.block}
          raw={previewRaw(view, row.block)}
          onClose={() => setPopup(null)}
        >
          <view.Preview block={row.block} />
        </PreviewModal>
      ) : null}

      {popup?.kind === "field" ? (
        <FieldEditor
          id="edit"
          title={`Edit ${popup.field.label}`}
          meta={row?.block.label}
          field={popup.field}
          error={error}
          saving={saving}
          onSubmit={(value) => void saveField(popup.field, value)}
          onCancel={() => setPopup(null)}
        />
      ) : null}

      {popup?.kind === "labelField" && row ? (
        <FieldEditor
          id="edit-label"
          title="Edit label"
          meta={row.block.kind}
          field={{ name: "label", label: "label", value: row.block.label }}
          error={error}
          saving={saving}
          onSubmit={(value) => void renameBlock(value)}
          onCancel={() => setPopup(null)}
        />
      ) : null}

      {popup?.kind === "callHook" ? (
        <FieldEditor
          id="call-hook"
          title={`Call ${popup.hook}`}
          meta="Argument (JSON, optional)"
          field={{ name: "arg", label: "Argument (JSON, optional)", value: "" }}
          error={error}
          saving={saving}
          onSubmit={(value) => runCallHook(popup.hook, value)}
          onCancel={() => setPopup(null)}
        />
      ) : null}

      {popup?.kind === "createKind" ? (
        <KeyMenu
          id="create-kind"
          title="New block"
          items={createKindItems}
          onClose={() => {
            setCreating(null);
            setPopup(null);
          }}
        />
      ) : null}

      {popup?.kind === "createUser" ? (
        <FieldEditor
          id="create-user"
          title="New message"
          field={{ name: "text", label: "message", value: "", multiline: true }}
          error={error}
          saving={saving}
          onSubmit={(value) => void createUserBlock(value)}
          onCancel={() => {
            setCreating(null);
            setPopup(null);
          }}
        />
      ) : null}

      {popup?.kind === "createLabel" && pendingKind ? (
        <FieldEditor
          id="create-label"
          title={`New ${pendingKind}`}
          field={{ name: "label", label: "label", value: pendingKind }}
          error={error}
          saving={saving}
          onSubmit={(value) => void createBlock(value || pendingKind)}
          onCancel={() => {
            setCreating(null);
            setPendingKind(null);
            setPopup(null);
          }}
        />
      ) : null}

      {popup?.kind === "createSession" ? (
        <FieldEditor
          id="create-session"
          title="New session"
          field={{ name: "name", label: "name", value: "" }}
          error={error}
          saving={saving}
          onSubmit={(value) => void createSession(value)}
          onCancel={() => setPopup(null)}
        />
      ) : null}

      {popup?.kind === "renameSession" && session ? (
        <FieldEditor
          id="rename-session"
          title={`Rename ${session.name}`}
          field={{ name: "name", label: "name", value: session.name }}
          error={error}
          saving={saving}
          onSubmit={(value) => void renameSession(value)}
          onCancel={() => setPopup(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Data loading for `/chat`, replacing the old server component's
 * `getStore()` read on the main process's behalf. On mount, and whenever the
 * `?session=` query param changes, loads that session's graph (or the most
 * recent one, absent a param) over IPC. `ChatView` is keyed by session id,
 * same as the original server-rendered page keying its client component,
 * so switching sessions resets `ChatView`'s own local state (cursor,
 * expanded rows, popups) instead of carrying it over into a different
 * graph entirely.
 */
export default function ChatPage() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session") ?? undefined;
  const [result, setResult] = useState<LoadGraphResult | null>(null);

  const load = useCallback(async () => {
    const next = await window.api.chat.loadGraph(sessionId);
    setResult(next);
  }, [sessionId]);

  useEffect(() => {
    // This is exactly the "fetch data from an external system on mount"
    // case effects are for. `setResult` only runs after the IPC round
    // trip resolves, never synchronously within the effect body, so there
    // is no cascading-render risk the rule is guarding against.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (!result) {
    return (
      <div className="flex min-h-full flex-col">
        <p className="p-3 text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <ChatView
      key={result.session?.id ?? "none"}
      sessions={result.sessions}
      session={result.session}
      initialGraph={result.graph}
      refetchSessions={load}
    />
  );
}
