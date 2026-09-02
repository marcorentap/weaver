"use client";

import { Fragment, type ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { Block, BlockGraph, BlockId, Position } from "@repo/core";
import { childIds, lastChildId, topLevelBlockIds } from "@repo/core";
import type { BlockInput } from "@repo/store";
import type { BlockField } from "@/blocks/views";
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
import { createLiveGraph, scheduledHooks } from "@/lib/live-graph";
import { kinds } from "@/blocks/kinds";
import { AGENT_KIND } from "@/blocks/agent";
import {
  createChatBlock,
  createChatSession,
  deleteChatBlock,
  moveChatBlock,
  renameChatSession,
  saveGraph,
  updateBlockField,
} from "./actions";

export type SessionSummary = { id: string; name: string; modifiedAt: number };

/** Which modal popup, if any, sits above chat's normal mode. */
type Popup =
  | { kind: "actions" }
  | { kind: "sessions" }
  | { kind: "preview" }
  | { kind: "field"; field: BlockField }
  | { kind: "configure" }
  | { kind: "callHook"; hook: string }
  | { kind: "createKind" }
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
 * means after the last row): right after the row above the gap, in that
 * row's own chain. So inserting right after a group's last child nests the
 * new block there too rather than popping back out to top-level, and
 * inserting after an unfolded group appends after the whole group rather
 * than into it. With no row above — the gap at the very top — it becomes the
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
 *  list) that inserts a new block at that exact gap. Zero height in flow —
 *  the button overlays the seam between rows instead of pushing them
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

/** Tall content is clipped to this many lines until it is unhidden. Rows are
 *  `text-xs`, whose line height is exactly `1rem`, so this is also its
 *  height in rem. */
const CLIP_LINES = 25;

function BlockRow({
  row,
  selected,
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
  /** Number to show in the gutter, or null when line numbers are off. */
  line: number | null;
  /** Whether this block has a hook in flight right now. */
  running: boolean;
  /** Whether the gutter column is enabled at all (hidden pre-hydration). */
  gutter: boolean;
  /** Whether this row's content is shown in full rather than clipped. */
  shown: boolean;
  /** Click anywhere on the row: select it and open its actions, like `enter`. */
  onSelect: () => void;
  /** Click the chevron: fold or unfold, without opening actions. */
  onToggle: () => void;
  /** Click the "more lines" marker: unhide the rest of this row. */
  onShow: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** Lines the clip is currently hiding, measured rather than guessed —
   *  markdown, images and fetched text all settle after the first render. */
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
    const inner = box.firstElementChild;
    const measure = () => {
      const height = parseFloat(getComputedStyle(box).lineHeight) || 16;
      const over = box.scrollHeight - box.clientHeight;
      setClipped(over > 1 ? Math.max(1, Math.round(over / height)) : 0);
    };
    measure();
    // The clip's own box never changes size, so the content inside it is what
    // has to be watched: a media block's text arrives long after mount.
    if (!inner) return;
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
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
          : "border-transparent hover:bg-muted/40",
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
        <span className="min-w-0 truncate font-medium">{row.block.label}</span>
      </span>
      <span className="w-16 shrink-0 text-muted-foreground">
        {row.block.kind}
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
            {clipped} more {clipped === 1 ? "line" : "lines"} — click or ctrl+o
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * A kind's full-size presentation, as its own mode.
 *
 * If the preview contains a player, it takes DOM focus: the keymap only
 * preventDefaults keys a layer binds, so space, arrows and volume keys reach
 * the element natively. Chat's own arrows are unreachable anyway while this
 * modal layer is on top — which is why focus is scoped to here and inline row
 * players are left unfocused.
 */
function PreviewModal({
  block,
  raw,
  onClose,
  children,
}: {
  block: Block;
  /** URL of the underlying file, if the kind exposes one. */
  raw: string | undefined;
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

  /** One line of vim-style scroll, in pixels — a reasonable step at the
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
              run: () => window.open(raw, "_blank", "noopener,noreferrer"),
            },
          ]
        : []),
      // No-ops when nothing in the preview scrolls (an image, a player) —
      // player already owns arrow keys, so j/k stay clear for that case too.
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

export function ChatView({
  sessions,
  session,
  initialGraph,
}: {
  sessions: SessionSummary[];
  session: { id: string; name: string } | null;
  initialGraph: BlockGraph;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<BlockId>>(
    () => new Set(),
  );
  /** Rows whose clipped content has been unhidden, and the override that
   *  unhides every row at once — `ctrl+o`. */
  const [shown, setShown] = useState<ReadonlySet<BlockId>>(() => new Set());
  const [showEverything, setShowEverything] = useState(false);
  const [popup, setPopup] = useState<Popup>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Where a pending "new block" flow will land, chosen before the kind and
   *  label are; `pendingKind` is the kind picked in the step after. */
  const [creating, setCreating] = useState<Position | null>(null);
  const [pendingKind, setPendingKind] = useState<string | null>(null);
  /** A block to select once it appears in `rows` — it may not exist there
   *  the same render it lands, if its container was not already expanded.
   *  `openActions` distinguishes "just created, show its actions" (create
   *  flow) from "just moved, only follow the cursor" (move/nest keys). */
  const [pendingFocus, setPendingFocus] = useState<
    { id: BlockId; openActions: boolean } | null
  >(null);
  const { settings, hydrated } = useSettings();

  // ---- Live graph state --------------------------------------------------
  // The client owns the graph from here on: a hook (a timer's tick, an ISS
  // fetch — this file has no idea which) mutates it and notifies
  // subscribers immediately, so it lands on screen the instant it resolves,
  // not on whatever cadence a poll happened to run at. `initialGraph` seeds
  // it once per mount — page keys `<ChatView>` by session id, so switching
  // sessions remounts rather than needing this to reconcile a changed prop
  // mid-life.
  const [engine] = useState(() => createLiveGraph(initialGraph));
  const { graph, dirty, savedAt, running } = useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
    engine.getSnapshot,
  );
  const liveNodes = chatNodes(graph);

  // One real `setInterval` per block asking for one, at its own configured
  // interval — this is what makes an update land within a millisecond of
  // when it fires, instead of at the next poll. Entirely kind-agnostic:
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
  // A fixed 3s cadence, not a debounce: a timer ticking every 2s would keep
  // resetting a debounce and never actually save. `performSaveRef` lets that
  // interval stay mounted for the component's life while always calling the
  // latest closure (current `session`, current engine).
  const performSave = useCallback(async (): Promise<void> => {
    if (!session) return;
    const result = await saveGraph(session.id, engine.toBlockInputs());
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
  // Follows a block to its new row the instant it shows up in `rows` —
  // immediately for a top-level block, one render later for a nested one,
  // since expanding its container also happens during this same "adjust
  // state while rendering" pass. Guarded by clearing `pendingFocus` once
  // applied, so this cannot loop.
  if (pendingFocus) {
    const i = rows.findIndex((entry) => entry.block.id === pendingFocus.id);
    if (i !== -1) {
      setCursor(i);
      if (pendingFocus.openActions) setPopup({ kind: "actions" });
      setPendingFocus(null);
    }
  }
  const index = Math.min(cursor, Math.max(rows.length - 1, 0));
  const row = rows[index];
  const view = row ? viewFor(row.block) : null;

  /** Whether the gutter column is live at all (hidden before hydration so the
   *  stored preference never flashes in with the wrong mode). */
  const gutter = hydrated && settings.lineNumber !== "off";
  /** Number for a row: absolute is its 1-based position; relative is its
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

  /** Jumps to the 1-based line number shown in the gutter — vim's `G`,
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

  /** The chain a container holds, in order — the top-level chain for null. */
  const siblingsOf = (containerId: BlockId | null) =>
    containerId === null ? topLevelBlockIds(graph) : childIds(graph, containerId);

  /** Relinks `id` at `at` locally and on the server, then follows it to its
   *  new row. The single path behind `J`/`K` and `>`/`<`: every structural
   *  edit is the same operation with a different target position. */
  const relocate = (id: BlockId, at: Position) => {
    if (!session) return;
    engine.moveBlock(id, at);
    if (at.parentId) setOpen(at.parentId, true);
    setPendingFocus({ id, openActions: false });
    startTransition(() => {
      void moveChatBlock(session.id, id, at);
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
    // previous one, which is "after the one before that" — or first in the
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
        help: { keys: "enter", label: "Actions for selected block" },
        run: () => {
          if (row) setPopup({ kind: "actions" });
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
    const result = await updateBlockField(
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
    // The server already validated this against the kind's schema, so it is
    // safe to reflect locally without waiting on a round trip back down.
    engine.updateField(row.block.id, field.name, coerced);
    setPopup(null);
  };

  /** Calls a callable directly from the configure menu — `argText` is
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
    const result = await createChatBlock(session.id, input, creating);
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

  /** Persists a new session, then switches to it — mirrors the recent-
   *  sessions `run` below, just against a graph that did not exist yet. */
  const createSession = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("name is required");
      return;
    }
    setSaving(true);
    const result = await createChatSession(trimmed);
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setPopup(null);
    setCursor(0);
    setExpanded(new Set());
    router.push(`/chat?session=${encodeURIComponent(trimmed)}`);
  };

  /** Renames the open session, then follows it to its new address — the URL
   *  addresses sessions by name, so the rename has to navigate. */
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
    const result = await renameChatSession(session.id, trimmed);
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setPopup(null);
    router.push(`/chat?session=${encodeURIComponent(trimmed)}`);
  };

  /**
   * The enter menu: whatever the kind declares (full-size preview, editable
   * fields), then the actions every block has.
   */
  const kind = row ? kinds[row.block.kind] : undefined;

  const actions: KeyMenuItem[] =
    row && view
      ? [
          {
            label: "Copy ID",
            key: "y",
            detail: row.block.id,
            run: () => {
              void navigator.clipboard.writeText(row.block.id);
              setPopup(null);
            },
          },
          ...(row.block.kind === AGENT_KIND
            ? [
                {
                  label: "Run agent",
                  key: "r",
                  run: () => {
                    setPopup(null);
                    void engine.runHook(row.block.id, "run", {
                      endpoint: settings.aiEndpoint,
                      apiKey: settings.aiApiKey,
                      model: settings.aiDefaultModel,
                    });
                  },
                },
              ]
            : []),
          ...(view.Preview
            ? [
                {
                  label: "Preview",
                  key: "p",
                  run: () => setPopup({ kind: "preview" }),
                },
              ]
            : []),
          ...(view.fields?.(row.block) ?? []).map((field) => ({
            label: `Edit ${field.label}`,
            // A blank field shows what it falls back to, not an empty column.
            detail: field.value || field.placeholder,
            run: () => openField(field),
          })),
          ...(kind && (kind.hooks.length > 0 || kind.callbacks.length > 0)
            ? [
                {
                  label: "Configure",
                  key: "c",
                  run: () => setPopup({ kind: "configure" }),
                },
              ]
            : []),
          {
            label: `Delete ${row.block.label}`,
            key: "d",
            destructive: true,
            run: () => {
              setPopup(null);
              const id = row.block.id;
              // Optimistic: drops the row immediately, then persists the
              // delete — everything nested inside it goes too, on both sides.
              engine.deleteBlock(id);
              if (session) {
                const graphId = session.id;
                startTransition(() => {
                  void deleteChatBlock(graphId, id);
                });
              }
            },
          },
        ]
      : [];

  /**
   * The configure menu: a block's callables (hooks it exposes, invocable
   * directly) and callbacks (its own references to another block's hook,
   * declared by its kind's `callbacks` — a timer's target, say).
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

  /** Only kinds with a schema-valid blank state show up here — see
   *  `BlockKind.defaults`. */
  const createKindItems: KeyMenuItem[] = Object.values(kinds)
    .filter((candidate) => candidate.defaults !== null)
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
        router.push(`/chat?session=${encodeURIComponent(entry.name)}`);
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
          title={row ? `Block ${row.block.label}` : "Block"}
          items={actions}
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
          raw={view.raw?.(row.block)}
          onClose={() => setPopup(null)}
        >
          <view.Preview block={row.block} />
        </PreviewModal>
      ) : null}

      {popup?.kind === "field" ? (
        <FieldEditor
          id="edit"
          title={row ? `Edit ${row.block.label}` : "Edit"}
          field={popup.field}
          error={error}
          saving={saving}
          onSubmit={(value) => void saveField(popup.field, value)}
          onCancel={() => setPopup(null)}
        />
      ) : null}

      {popup?.kind === "callHook" ? (
        <FieldEditor
          id="call-hook"
          title={`Call ${popup.hook}`}
          field={{
            name: "arg",
            label: "Argument (JSON, optional)",
            value: "",
          }}
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
