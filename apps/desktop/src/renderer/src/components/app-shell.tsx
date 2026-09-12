import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { useChatStore } from "@/lib/chat-store";
import { newSessionTitle } from "@shared/session-title.js";
import {
  HELP_KEY,
  KeyFrameProvider,
  KeymapProvider,
  useKeyLayer,
  useToggleHelp,
} from "@/lib/keymap";
import { FieldEditor } from "@/components/field-editor";
import { KeyMenu, type KeyMenuItem } from "@/components/key-menu";
import { PAGES, type Page } from "@/lib/pages";
import { APP_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  CHAT_PAGE,
  findPane,
  initialLayout,
  makePane,
  makeTab,
  orderedPanes,
  paneGeometry,
  reduceLayout,
  tabLabelOf,
  type Layout,
  type Pane,
  type PaneRect,
} from "@/lib/shell";

/** The router object `createMemoryRouter` builds — one per pane. */
export type PaneRouter = ReturnType<typeof createMemoryRouter>;

/** The shell's own header region. A page fills it through `ShellHeader`, so
 *  its bar is a sibling of the pane rather than the first row of the
 *  scrolling content. Every pane provides one of these to itself, so each
 *  split pane draws its own header. */
const headerSlot = createContext<HTMLElement | null>(null);

export function ShellHeader({ children }: { children: React.ReactNode }) {
  const node = useContext(headerSlot);
  return node ? createPortal(children, node) : null;
}

function pageIdForPath(pathname: string): string {
  return PAGES.find((page) => page.href === pathname)?.id ?? CHAT_PAGE.id;
}

/** `?session=` URL for a chat session id. */
function chatHref(id: string): string {
  return `/chat?session=${encodeURIComponent(id)}`;
}

/** How many pixels one `ctrl+w` + `alt+h/j/k/l` press moves a divider. */
const PANE_RESIZE_PX = 10;

/**
 * Normal mode stays the bottom of the keymap stack, live everywhere. Page
 * layers stack on top of it, so tab switching keeps working inside a page's
 * mode and stops only inside a modal popup.
 */
function NormalMode({
  onOpenTabs,
  onSwitch,
}: {
  onOpenTabs: () => void;
  onSwitch: (delta: number) => void;
}) {
  useKeyLayer({
    id: "normal",
    bindings: [
      {
        keys: ["Tab", " "],
        help: { keys: "tab / space", label: "Tabs" },
        run: onOpenTabs,
      },
      {
        keys: ["["],
        help: { keys: "[", label: "Previous tab" },
        run: () => onSwitch(-1),
      },
      {
        keys: ["]"],
        help: { keys: "]", label: "Next tab" },
        run: () => onSwitch(1),
      },
    ],
  });

  return null;
}

/**
 * The pane layer: every tab's panes are steered from the same layer, all on
 * the `ctrl+w` leader (`ctrl+w` + `alt+h/j/k/l` resizes). The layout owns the
 * panes, so the shortcuts always hit the active tab's active pane.
 */
function PaneMode({
  onSplit,
  onMove,
  onResize,
  onClosePane,
}: {
  onSplit: (dir: "row" | "column") => void;
  onMove: (dir: "h" | "j" | "k" | "l" | "next") => void;
  onResize: (dir: "h" | "j" | "k" | "l") => void;
  onClosePane: () => void;
}) {
  useKeyLayer({
    id: "panes",
    bindings: [
      {
        chord: ["ctrl+w", "v"],
        help: { keys: "ctrl+w v", label: "Split vertically" },
        run: () => onSplit("row"),
      },
      {
        chord: ["ctrl+w", "s"],
        help: { keys: "ctrl+w s", label: "Split horizontally" },
        run: () => onSplit("column"),
      },
      {
        chord: ["ctrl+w", "h"],
        help: { keys: "ctrl+w h", label: "Pane left" },
        run: () => onMove("h"),
      },
      {
        chord: ["ctrl+w", "j"],
        help: { keys: "ctrl+w j", label: "Pane below" },
        run: () => onMove("j"),
      },
      {
        chord: ["ctrl+w", "k"],
        help: { keys: "ctrl+w k", label: "Pane above" },
        run: () => onMove("k"),
      },
      {
        chord: ["ctrl+w", "l"],
        help: { keys: "ctrl+w l", label: "Pane right" },
        run: () => onMove("l"),
      },
      {
        chord: ["ctrl+w", "ctrl+w"],
        help: { keys: "ctrl+w ctrl+w", label: "Next pane" },
        run: () => onMove("next"),
      },
      {
        chord: ["ctrl+w", "q"],
        help: { keys: "ctrl+w q", label: "Close pane" },
        run: onClosePane,
      },
      {
        chord: ["ctrl+w", "alt+h"],
        repeatable: true, // alt+h again keeps resizing
        help: { keys: "ctrl+w alt+h", label: "Resize left" },
        run: () => onResize("h"),
      },
      {
        chord: ["ctrl+w", "alt+l"],
        repeatable: true,
        help: { keys: "ctrl+w alt+l", label: "Resize right" },
        run: () => onResize("l"),
      },
      {
        chord: ["ctrl+w", "alt+j"],
        repeatable: true,
        help: { keys: "ctrl+w alt+j", label: "Resize down" },
        run: () => onResize("j"),
      },
      {
        chord: ["ctrl+w", "alt+k"],
        repeatable: true,
        help: { keys: "ctrl+w alt+k", label: "Resize up" },
        run: () => onResize("k"),
      },
    ],
  });

  return null;
}

/**
 * The digits `1..9` live while the tabs popup is up, a layer with no rows of
 * its own, so the popup stays actions and pages. It answers only to numbers;
 * everything else falls through to the menu modal below. It renders *after*
 * the popup in the shell so its layer lands on top of the menu's.
 */
function TabNumbers({
  count,
  onPick,
}: {
  count: number;
  onPick: (index: number) => void;
}) {
  useKeyLayer({
    id: "tab-numbers",
    bindings: Array.from({ length: Math.min(count, 9) }, (_, i) => ({
      keys: [String(i + 1)],
      help: { keys: String(i + 1), label: `Switch to tab ${i + 1}` },
      run: () => onPick(i),
    })),
  });

  return null;
}

/** Bottom tab bar. `activeId` decides the highlight; the numbers are the
 *  tabs' own indexes. */
function TabBar({
  layout,
  onActivate,
}: {
  layout: Layout;
  onActivate: (tabId: string) => void;
}) {
  const toggleHelp = useToggleHelp();
  const { tabs, activeTabId } = layout;

  return (
    <nav className="flex items-center gap-1 border-t px-2 py-1">
      {tabs.map((tab, i) => {
        const active = tab.id === activeTabId;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onActivate(tab.id)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "px-2 py-0.5",
              active
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            [{i + 1} {tabLabelOf(tab)}]
          </button>
        );
      })}
      {/* The one key that has to be discoverable without opening help. */}
      <button
        type="button"
        onClick={toggleHelp}
        className="ml-auto px-2 py-0.5 text-muted-foreground hover:text-foreground"
      >
        {HELP_KEY} Help
      </button>
    </nav>
  );
}

/**
 * One pane: a header row of its own (portal for `ShellHeader`), then the
 * page inside the pane's own scroll box, backed by the pane's own in-memory
 * router. The router is created once and lives as long as the pane mounts.
 * The shell keeps every pane's slot mounted for the pane's whole life
 * (splits reshuffle only their `rect`), so a pane's router — and with it
 * every page under it — survives a tab switch or a neighbouring split
 * closing; it is destroyed only when its own pane is closed.
 */
function PaneSlot({
  pane,
  rect,
  focused,
  onFocus,
  onRecord,
  registerRouter,
}: {
  pane: Pane;
  rect: PaneRect;
  focused: boolean;
  onFocus: () => void;
  onRecord: (paneId: string, pageId: string, to: string) => void;
  registerRouter: (paneId: string, router: PaneRouter | null) => void;
}) {
  // Created once, from the pane's recorded location at mount.
  const [router] = useState(() =>
    createMemoryRouter(APP_ROUTES, { initialEntries: [pane.to] }),
  );
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  // The shell reaches into this pane's router (opening a page from the tabs
  // popup, aiming a fresh chat pane at its new session) through the router
  // registry, keyed by pane id, kept in step with the pane's lifetime.
  useEffect(() => {
    registerRouter(pane.id, router);
    return () => registerRouter(pane.id, null);
  }, [pane.id, router, registerRouter]);

  // The pane's recorded `to` is the shell's truth for where it should be;
  // when it changes (a fresh session, a page opened in the pane), follow it.
  // After that the pane's own router is authoritative: an in-pane navigation
  // is recorded back through onRecord.
  useEffect(() => {
    const current =
      router.state.location.pathname + router.state.location.search;
    if (current !== pane.to) {
      router.navigate(pane.to, { replace: true });
    }
  }, [pane.to, router]);

  // Report every in-pane navigation back to the shell, so the tab label and
  // the pane's record keep tracking the page and location.
  useEffect(() => {
    return router.subscribe((state) => {
      const to = state.location.pathname + state.location.search;
      const pageId = pageIdForPath(state.location.pathname);
      if (pageId !== pane.pageId || to !== pane.to)
        onRecord(pane.id, pageId, to);
    });
  }, [router, pane.id, pane.pageId, pane.to, onRecord]);

  return (
    <KeyFrameProvider id={pane.id}>
      <div
        onMouseDownCapture={onFocus}
        className={cn(
          // Absolute slot laid out by the tab's `paneGeometry`; the shared
          // leading borders are the split dividers.
          "absolute flex h-full min-h-0 w-full flex-col overflow-hidden bg-background",
          focused && "ring-1 ring-inset ring-muted-foreground/40",
          rect.left > 0 && "border-l border-border",
          rect.top > 0 && "border-t border-border",
        )}
        style={{
          left: `${rect.left}%`,
          top: `${rect.top}%`,
          width: `${rect.width}%`,
          height: `${rect.height}%`,
        }}
      >
        {/* Empty until a page portals into it, so a page without a bar loses
            no height. */}
        <div ref={setSlot} className="shrink-0 empty:hidden" />
        <headerSlot.Provider value={slot}>
          <div className="relative min-h-0 flex-1 overflow-y-auto scrollbar-none">
            <RouterProvider router={router} />
          </div>
        </headerSlot.Provider>
      </div>
    </KeyFrameProvider>
  );
}

/** The startup layout: a single tab with a single chat pane on the chat
 *  home page. A pane holds no session yet — `AppShell` aims it at a
 *  brand-new one on mount, so boot is always a fresh chat, never someone
 *  else's (or last run's) last one. The pane id is captured here so the
 *  claim can target it. */
const STARTUP_LAYOUT = initialLayout();
const startupPaneId = STARTUP_LAYOUT.tabs[0]!.activePaneId;

export function AppShell() {
  const [layout, dispatch] = useReducer(reduceLayout, STARTUP_LAYOUT);
  const { createChatSession } = useChatStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Whether the rename-tab dialog is up, over the popup layer. */
  const [renaming, setRenaming] = useState(false);
  /** Every live pane's router, keyed by pane id, so the shell can navigate a
   *  pane from outside of it. */
  const routers = useRef(new Map<string, PaneRouter>());
  /** The pane area, measured so resize deltas are exact pixels. */
  const paneAreaRef = useRef<HTMLDivElement | null>(null);

  const activeTab =
    layout.tabs.find((tab) => tab.id === layout.activeTabId) ?? layout.tabs[0];
  /** The pane keyboard focus sits in — the layout's single truth for both
   *  the keymap's scoped dispatch and the pane pool's `focused` ring. */
  const focusedPaneId = activeTab ? activeTab.activePaneId : null;

  // The startup tab is a fresh chat: create a session (seeded by the global
  // chat store, so no per-pane load) and aim the startup pane at it, so
  // boot is a brand-new session rather than the most recently modified one.
  // The claim only sticks while the pane still sits on the untouched chat
  // home page (the reducer guards that), so a failed session creation leaves
  // a usable chat tab.
  useEffect(() => {
    let cancelled = false;
    void createChatSession(newSessionTitle()).then((result) => {
      if (cancelled || result.error || !result.id) return;
      dispatch({
        type: "retarget-pane",
        paneId: startupPaneId,
        to: chatHref(result.id),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [createChatSession]);

  /** Mint a brand-new empty chat session — seeded by the global chat store,
   *  so the pane that gets it mounts with zero IPC — and build a pane aimed
   *  straight at it. A tab or split built from this renders the session
   *  once, on the chat it owns, instead of first mounting the most recent
   *  session at `/chat` and being retargeted a moment later (two full chat
   *  mounts and a flash of the previous session per pane). If creation
   *  fails, the pane falls back to the chat home page, still usable. */
  const freshChatPane = useCallback(async (): Promise<Pane> => {
    const result = await createChatSession(newSessionTitle());
    return makePane(
      CHAT_PAGE.id,
      result.error || !result.id ? CHAT_PAGE.href : chatHref(result.id),
    );
  }, [createChatSession]);

  /** The pane registry: register/deregister a pane's router. */
  const registerRouter = useCallback(
    (paneId: string, router: PaneRouter | null) => {
      if (router) routers.current.set(paneId, router);
      else routers.current.delete(paneId);
    },
    [],
  );

  /** Called by a pane whenever its own router lands somewhere brand-new. */
  const onPaneRecord = useCallback(
    (paneId: string, pageId: string, to: string) => {
      dispatch({ type: "record-pane", paneId, pageId, to });
    },
    [],
  );

  /** n in the popup: mint a brand-new empty session, then open the tab with
   *  its pane already on that session — the pane mounts once, on its own
   *  empty chat, with no flash of the previous session and nothing to
   *  retarget. A failed session creation still opens a usable chat tab on
   *  the chat home page. */
  const newTab = useCallback(async () => {
    setPickerOpen(false);
    dispatch({ type: "new-tab", tab: makeTab(await freshChatPane()) });
  }, [freshChatPane]);

  /** `tab`/`space`'s result and the tab bar's click: show the tab. */
  const activateTab = useCallback((tabId: string) => {
    setPickerOpen(false);
    dispatch({ type: "activate-tab", tabId });
  }, []);

  const switchTab = useCallback(
    (delta: number) => {
      if (layout.tabs.length === 0) return;
      const index = Math.max(
        layout.tabs.findIndex((tab) => tab.id === layout.activeTabId),
        0,
      );
      const next =
        layout.tabs[(index + delta + layout.tabs.length) % layout.tabs.length]!;
      activateTab(next.id);
    },
    [layout.tabs, layout.activeTabId, activateTab],
  );

  /** The popup's number keys: jump to a tab and close the popup. */
  const switchToNumber = useCallback(
    (index: number) => {
      const tab = layout.tabs[index];
      if (!tab) return;
      activateTab(tab.id);
    },
    [layout.tabs, activateTab],
  );

  /** `d` in the popup: close the active tab, landing on its right neighbour
   *  (or left, at the end). The last tab never closes. */
  const closeTab = useCallback(() => {
    setPickerOpen(false);
    dispatch({ type: "close-tab", tabId: layout.activeTabId });
  }, [layout.activeTabId]);

  /** `ctrl+w v` / `ctrl+w s`: split the active pane and move to the fresh
   *  one. A chat split mints the new pane's own session first, so the fresh
   *  pane mounts directly on it — one chat mount, zero flash, and never two
   *  live graphs sharing a session (the new pane lands on its session, not
   *  partway through the active one's). */
  const splitPane = useCallback(
    async (dir: "row" | "column") => {
      if (!activeTab) return;
      const pane = findPane(activeTab.root, activeTab.activePaneId);
      if (!pane) return;
      const fresh =
        pane.pageId === CHAT_PAGE.id
          ? await freshChatPane()
          : makePane(pane.pageId, pane.to);
      dispatch({ type: "split-pane", dir, fresh });
    },
    [activeTab, freshChatPane],
  );

  /** `ctrl+w h/j/k/l` (and `ctrl+w ctrl+w`): move pane focus. */
  const movePane = useCallback((dir: "h" | "j" | "k" | "l" | "next") => {
    dispatch({ type: "move-focus", dir });
  }, []);

  /** `ctrl+w` + `alt+h/j/k/l`: nudge the active pane's divider 10px in the
   *  pressed direction — whether the pane grows or shrinks depends on where
   *  it sits, which the reducer decides. The pane area's measured extent
   *  turns the pixel amount into the share change. */
  const resizePane = useCallback((dir: "h" | "j" | "k" | "l") => {
    const area = paneAreaRef.current;
    if (!area) return;
    const axis = dir === "h" || dir === "l" ? "row" : "column";
    const size = axis === "row" ? area.clientWidth : area.clientHeight;
    if (size <= 0) return;
    dispatch({ type: "resize-pane", dir, delta: PANE_RESIZE_PX, size });
  }, []);

  /** `ctrl+w q`: close the active pane, focusing the tree's first survivor.
   *  A tab's last pane closing is the tab closing (like `d` in the popup). */
  const closePane = useCallback(() => {
    dispatch({ type: "close-pane" });
  }, []);

  /** `r` in the popup: a custom label for the active tab. Clearing it falls
   *  back to the active pane's page name. */
  const renameTab = useCallback((label: string) => {
    dispatch({ type: "rename-tab", label });
  }, []);

  /** The popup's pages open in the active *pane*, which has its own page
   *  and router now. Navigate the pane's router; it reports the new page
   *  back itself. */
  const openPageInPane = useCallback(
    (page: Page) => {
      setPickerOpen(false);
      if (!activeTab) return;
      const pane = findPane(activeTab.root, activeTab.activePaneId);
      if (!pane || pane.pageId === page.id) return;
      routers.current.get(pane.id)?.navigate(page.href);
    },
    [activeTab],
  );

  const pickerItems: KeyMenuItem[] = [
    {
      key: "n",
      label: "New tab",
      run: newTab,
    },
    {
      label: "Rename tab",
      detail: activeTab ? tabLabelOf(activeTab) : undefined,
      run: () => {
        setPickerOpen(false);
        setRenaming(true);
      },
    },
    {
      key: "d",
      label: "Close tab",
      detail: activeTab ? tabLabelOf(activeTab) : undefined,
      destructive: true,
      run: closeTab,
    },
    ...PAGES.map((page) => ({
      key: page.key,
      label: page.label,
      detail: "Open in this pane",
      run: () => openPageInPane(page),
    })),
  ];

  return (
    <KeymapProvider activePaneId={focusedPaneId}>
      <PaneMode
        onSplit={splitPane}
        onMove={movePane}
        onResize={resizePane}
        onClosePane={closePane}
      />
      <NormalMode onOpenTabs={() => setPickerOpen(true)} onSwitch={switchTab} />

      {/* The pane area: every tab's panes stay mounted, keyed by pane id,
            exactly one instance per pane for its whole life; hidden tabs
            merely lie `display:none`, so a tab switch never costs a session
            reload and a split never reshuffles live pages. Geometry (which
            pane sits where) comes from the tab's pane tree; each pane's
            `PaneSlot` is positioned absolutely by its rect. */}
      <div
        ref={paneAreaRef}
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        {layout.tabs.map((tab) => {
          const rects = paneGeometry(tab.root);
          const visible = tab.id === layout.activeTabId;
          // A tab with a single pane has no split dividers to read, so its
          // focused pane doesn't need the ring either.
          const panes = orderedPanes(tab.root);
          return (
            <div
              key={tab.id}
              className={cn(visible ? "absolute inset-0" : "hidden")}
            >
              {panes.map((pane) => {
                const rect = rects.get(pane.id);
                if (!rect) return null;
                const focused = visible && pane.id === focusedPaneId;
                return (
                  <PaneSlot
                    key={pane.id}
                    pane={pane}
                    rect={rect}
                    focused={focused && panes.length > 1}
                    onFocus={() =>
                      dispatch({ type: "focus-pane", paneId: pane.id })
                    }
                    onRecord={onPaneRecord}
                    registerRouter={registerRouter}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      <TabBar layout={layout} onActivate={activateTab} />
      {pickerOpen ? (
        <KeyMenu
          id="tabs"
          title="Tabs"
          meta={activeTab ? tabLabelOf(activeTab) : undefined}
          items={pickerItems}
          hint="NUM — switch to a tab"
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {pickerOpen ? (
        <TabNumbers count={layout.tabs.length} onPick={switchToNumber} />
      ) : null}
      {renaming && activeTab ? (
        <FieldEditor
          id="rename-tab"
          title={`Rename ${tabLabelOf(activeTab)}`}
          field={{
            name: "label",
            label: "tab label",
            value: tabLabelOf(activeTab),
          }}
          error={null}
          saving={false}
          onSubmit={(value) => {
            setRenaming(false);
            renameTab(value);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : null}
    </KeymapProvider>
  );
}
