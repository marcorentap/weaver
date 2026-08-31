"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Block, BlockId } from "@repo/core";
import type { BlockField } from "@/blocks/views";
import { ShellHeader } from "@/components/app-shell";
import { viewFor } from "@/blocks/views";
import { FieldEditor } from "@/components/field-editor";
import type { KeyMenuItem } from "@/components/key-menu";
import { KeyMenu } from "@/components/key-menu";
import { ModalFrame } from "@/components/modal-frame";
import { useKeyLayer } from "@/lib/keymap";
import { cn } from "@/lib/utils";
import { deleteChatBlock, updateBlockField } from "./actions";

export type SessionSummary = { id: string; name: string; modifiedAt: number };

/** A block plus its nested contexts, already in render order. */
export type ChatNode = { block: Block; children: ChatNode[] };

/** Which modal popup, if any, sits above chat's normal mode. */
type Popup =
  | { kind: "actions" }
  | { kind: "sessions" }
  | { kind: "preview" }
  | { kind: "field"; field: BlockField }
  | null;

/** One rendered row of the unfolded tree; media rows are taller than a line. */
type Row = {
  block: Block;
  depth: number;
  /** Row index of the enclosing block, so `←` can climb out of a group. */
  parent: number | null;
  hasChildren: boolean;
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
      hasChildren: node.children.length > 0,
      expanded: open,
    });
    if (open) flatten(node.children, expanded, depth + 1, index, rows);
  }
  return rows;
}

function BlockRow({
  row,
  selected,
  onSelect,
  onToggle,
}: {
  row: Row;
  selected: boolean;
  /** Click anywhere on the row: select it and open its actions, like `enter`. */
  onSelect: () => void;
  /** Click the chevron: fold or unfold, without opening actions. */
  onToggle: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const view = viewFor(row.block);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div
      ref={ref}
      aria-selected={selected}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-3 border-l-2 px-3 py-1",
        selected
          ? "border-foreground/60 bg-muted"
          : "border-transparent hover:bg-muted/40",
      )}
    >
      <span
        // Indent eats into this column, so it is wide enough for a couple of
        // nesting levels before labels start truncating.
        className="flex w-52 shrink-0 items-center gap-1"
        style={{ paddingLeft: `${row.depth * INDENT_REM}rem` }}
      >
        {row.hasChildren ? (
          <button
            type="button"
            aria-label={row.expanded ? "collapse" : "expand"}
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
          <span className="size-6 shrink-0" />
        )}
        <span className="min-w-0 truncate font-medium">{row.block.label}</span>
      </span>
      <span className="w-16 shrink-0 text-muted-foreground">
        {row.block.kind}
      </span>
      <view.Row block={row.block} />
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

  useKeyLayer({
    id: "preview",
    modal: true,
    bindings: [
      ...(raw
        ? [
            {
              keys: ["Enter"],
              help: { keys: "enter", label: "open file in a new tab" },
              run: () => window.open(raw, "_blank", "noopener,noreferrer"),
            },
          ]
        : []),
      {
        keys: ["Escape", "q"],
        help: { keys: "esc / q", label: "close" },
        run: onClose,
      },
    ],
    // Owned by the focused player, not by the keymap.
    docs: player
      ? [
          { keys: "space", label: "play / pause" },
          { keys: "← / →", label: "seek" },
          { keys: "↑ / ↓", label: "volume" },
        ]
      : [],
  });

  return (
    <ModalFrame
      label={`preview ${block.label}`}
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
  nodes,
  total,
}: {
  sessions: SessionSummary[];
  session: { id: string; name: string } | null;
  nodes: ChatNode[];
  total: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<BlockId>>(
    () => new Set(),
  );
  const [popup, setPopup] = useState<Popup>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = flatten(nodes, expanded);
  const index = Math.min(cursor, Math.max(rows.length - 1, 0));
  const row = rows[index];
  const view = row ? viewFor(row.block) : null;

  const move = (delta: number) => {
    if (rows.length === 0) return;
    setCursor(Math.min(Math.max(index + delta, 0), rows.length - 1));
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
    if (row.hasChildren && !row.expanded) setOpen(row.block.id, true);
    else if (row.expanded) move(1);
  };

  /** Fold, or climb out to the enclosing block when there is nothing to fold. */
  const collapse = () => {
    if (!row) return;
    if (row.expanded) setOpen(row.block.id, false);
    else if (row.parent !== null) setCursor(row.parent);
  };

  useKeyLayer({
    id: "chat",
    bindings: [
      {
        keys: ["ArrowDown", "j"],
        help: { keys: "↓ / j", label: "next block" },
        run: () => move(1),
      },
      {
        keys: ["ArrowUp", "k"],
        help: { keys: "↑ / k", label: "previous block" },
        run: () => move(-1),
      },
      {
        keys: ["ArrowRight", "l"],
        help: { keys: "→ / l", label: "open nested contexts, then step in" },
        run: expand,
      },
      {
        keys: ["ArrowLeft", "h"],
        help: { keys: "← / h", label: "close nested contexts, then step out" },
        run: collapse,
      },
      {
        keys: ["Enter"],
        help: { keys: "enter", label: "actions for selected block" },
        run: () => {
          if (row) setPopup({ kind: "actions" });
        },
      },
      {
        keys: ["s"],
        help: { keys: "s", label: "recent sessions" },
        run: () => setPopup({ kind: "sessions" }),
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
    const result = await updateBlockField(
      session.id,
      row.block.id,
      field.name,
      value,
    );
    setSaving(false);
    if (result.error) setError(result.error);
    else setPopup(null);
  };

  /**
   * The enter menu: whatever the kind declares (full-size preview, editable
   * fields), then the actions every block has.
   */
  const actions: KeyMenuItem[] =
    row && view
      ? [
          ...(view.Preview
            ? [
                {
                  label: "preview",
                  key: "p",
                  run: () => setPopup({ kind: "preview" }),
                },
              ]
            : []),
          ...(view.fields?.(row.block) ?? []).map((field) => ({
            label: `edit ${field.label}`,
            detail: field.value,
            run: () => openField(field),
          })),
          {
            label: `delete ${row.block.label}`,
            key: "d",
            destructive: true,
            run: () => {
              setPopup(null);
              startTransition(() => deleteChatBlock(row.block.id));
            },
          },
        ]
      : [];

  const sessionItems: KeyMenuItem[] = sessions.map((entry) => ({
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
  }));

  return (
    <div className="flex min-h-full flex-col">
      <ShellHeader>
        <header className="flex items-center gap-3 border-b px-3 py-1">
          <span className="font-semibold">chat</span>
          <span className="text-muted-foreground">
            {session ? `session ${session.name}` : "no session"}
          </span>
          <span className="text-muted-foreground">
            {nodes.length} top level · {total} blocks
          </span>
        </header>
      </ShellHeader>

      {rows.length === 0 ? (
        <p className="p-3 text-muted-foreground">
          No blocks in this session. Sending messages is not wired up yet.
        </p>
      ) : (
        <div className="py-1">
          {rows.map((entry, i) => (
            <BlockRow
              key={entry.block.id}
              row={entry}
              selected={i === index}
              onSelect={() => {
                setCursor(i);
                setPopup({ kind: "actions" });
              }}
              onToggle={() => {
                setCursor(i);
                setOpen(entry.block.id, !entry.expanded);
              }}
            />
          ))}
        </div>
      )}

      {popup?.kind === "actions" ? (
        <KeyMenu
          id="actions"
          title={row ? `block ${row.block.label}` : "block"}
          items={actions}
          onClose={() => setPopup(null)}
        />
      ) : null}

      {popup?.kind === "sessions" ? (
        <KeyMenu
          id="sessions"
          title="recent sessions"
          items={sessionItems}
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
          title={row ? `edit ${row.block.label}` : "edit"}
          field={popup.field}
          error={error}
          saving={saving}
          onSubmit={(value) => void saveField(popup.field, value)}
          onCancel={() => setPopup(null)}
        />
      ) : null}
    </div>
  );
}
