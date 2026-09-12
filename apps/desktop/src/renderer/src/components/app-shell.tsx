import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  createMemoryRouter,
  RouterProvider,
} from "react-router-dom";
import { SettingsProvider } from "@/lib/settings";
import {
  HELP_KEY,
  KeymapProvider,
  useKeyLayer,
  useToggleHelp,
} from "@/lib/keymap";
import { FieldEditor } from "@/components/field-editor";
import { KeyMenu, type KeyMenuItem } from "@/components/key-menu";
import { PAGES, type Page } from "@/lib/pages";
import { APP_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

/** The router object `createMemoryRouter` builds — one per pane. */
type PaneRouter = ReturnType<typeof createMemoryRouter>;

/**
 * The shell's own header region. A page fills it through `ShellHeader`, so its
 * bar is a sibling of the pane rather than the first row of the scrolling
 * content. Every pane provides one of these to itself, so each split pane
 * draws its own header.
 */
const headerSlot = createContext<HTMLElement | null>(null);

export function ShellHeader({ children }: { children: React.ReactNode }) {
  const node = useContext(headerSlot);
  return node ? createPortal(children, node) : null;
}

/**
 * A pane: one slot inside a tab that owns a page outright. `pageId` is the
 * page currently rendering in it (the tab bar's label follows the active
 * pane), `to` its in-pane location, query string included, so a chat pane
 * keeps its session's URL when the page navigates under it.
 */
type Pane = { id: string; pageId: string; to: string };

/**
 * A tab's pane tree. Leaves are panes; splits hold two or more children along
 * one axis (`row` = side by side across a vertical dividing line, vim's
 * vertical split; `column` = stacked across a horizontal dividing line, vim's
 * horizontal split). `weights` are each child's share of the split, nudged by
 * `alt+h/j/k/l`.
 */
type PaneNode =
  | { kind: "leaf"; id: string; pane: Pane }
  | {
      kind: "split";
      id: string;
      dir: "row" | "column";
      weights: number[];
      children: PaneNode[];
    };

/** One open tab. A tab owns its pane tree; switching tabs never touches the
 *  panes, it just shows a different tree. An optional `label` names the tab
 *  itself, set with `r` in the popup; blank falls back to the active pane's
 *  page name. `activePaneId` is the pane keyboard focus sits in. */
type Tab = { id: string; label?: string; root: PaneNode; activePaneId: string };

/** The startup layout is a single tab with a single chat pane: nothing else.
 *  Its pane holds no session yet — `AppShell` aims it at a brand-new one on
 *  mount, so boot is always a fresh chat, never someone else's (or last
 *  run's) last one. */
const STARTUP_TAB: Tab = (() => {
  const paneId = `pane-${crypto.randomUUID()}`;
  return {
    id: `tab-${crypto.randomUUID()}`,
    root: {
      kind: "leaf",
      id: paneId,
      pane: { id: paneId, pageId: PAGES[0]!.id, to: PAGES[0]!.href },
    },
    activePaneId: paneId,
  };
})();

function pageLabelOf(pageId: string): string {
  return PAGES.find((page) => page.id === pageId)?.label ?? pageId;
}

function tabLabel(tab: Tab): string {
  const pane = leafOf(tab.root, tab.activePaneId);
  return tab.label ?? (pane ? pageLabelOf(pane.pageId) : "…");
}

/** The pane with `id`, or null when it isn't under `node`. */
function leafOf(node: PaneNode, id: string): Pane | null {
  if (node.kind === "leaf") return node.pane.id === id ? node.pane : null;
  for (const child of node.children) {
    const found = leafOf(child, id);
    if (found) return found;
  }
  return null;
}

function containsPane(node: PaneNode, id: string): boolean {
  return leafOf(node, id) !== null;
}

/** Every leaf pane id, in tree order (left to right, top to bottom). */
function orderedPaneIds(node: PaneNode): string[] {
  if (node.kind === "leaf") return [node.pane.id];
  const out: string[] = [];
  for (const child of node.children) out.push(...orderedPaneIds(child));
  return out;
}

/** Replace a pane's recorded location in the tree, keeping its page. The
 *  pane component follows it and navigates its own router there. */
function setPaneTo(node: PaneNode, paneId: string, to: string): PaneNode {
  if (node.kind === "leaf") {
    if (node.pane.id !== paneId) return node;
    return { ...node, pane: { ...node.pane, to } };
  }
  return {
    ...node,
    children: node.children.map((child) => setPaneTo(child, paneId, to)),
  };
}

/** Replace both the page and the recorded location (an in-pane navigation). */
function setPaneRecord(
  node: PaneNode,
  paneId: string,
  pageId: string,
  to: string,
): PaneNode {
  if (node.kind === "leaf") {
    if (node.pane.id !== paneId) return node;
    return { ...node, pane: { ...node.pane, pageId, to } };
  }
  return {
    ...node,
    children: node.children.map((child) => setPaneRecord(child, paneId, pageId, to)),
  };
}

/** `setPaneTo`, but only while the pane still sits on the chat home page, so
 *  a fresh session landing late never yanks a pane the user already moved. */
function retargetLeaf(node: PaneNode, paneId: string, to: string): PaneNode {
  if (node.kind === "leaf") {
    if (node.pane.id !== paneId) return node;
    const atHome =
      node.pane.pageId === PAGES[0]!.id && node.pane.to === PAGES[0]!.href;
    return atHome ? { ...node, pane: { ...node.pane, to } } : node;
  }
  return {
    ...node,
    children: node.children.map((child) => retargetLeaf(child, paneId, to)),
  };
}

/**
 * Turn `paneId`'s leaf into a split holding the original pane and a fresh one
 * along `dir`. The fresh pane starts on the splitting pane's own page — but
 * a chat pane starts on the chat home page, and its brand-new session arrives
 * a moment later (via `aimAtFreshChat`), so a split never mounts two live
 * graphs on the same session.
 */
function splitLeaf(
  node: PaneNode,
  paneId: string,
  dir: "row" | "column",
): { node: PaneNode; freshId: string } {
  const freshId = `pane-${crypto.randomUUID()}`;
  const walk = (n: PaneNode): PaneNode => {
    if (n.kind === "leaf") {
      if (n.pane.id !== paneId) return n;
      const fresh: Pane = {
        id: freshId,
        pageId: n.pane.pageId,
        to: n.pane.pageId === PAGES[0]!.id ? PAGES[0]!.href : n.pane.to,
      };
      // New panes go right (row) / below (column), and the fresh one takes
      // the cursor, exactly like vim's `ctrl+w v` / `ctrl+w s`.
      return {
        kind: "split",
        id: `split-${crypto.randomUUID()}`,
        dir,
        weights: [1, 1],
        children: [n, { kind: "leaf", id: freshId, pane: fresh }],
      };
    }
    return { ...n, children: n.children.map(walk) };
  };
  return { node: walk(node), freshId };
}

/** Drop `paneId`'s leaf (and collapse a split left with a single child). */
function removePane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === "leaf") return node.pane.id === paneId ? null : node;
  const children = node.children
    .map((child) => removePane(child, paneId))
    .filter((child): child is PaneNode => child !== null);
  if (children.length === node.children.length) return node;
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children };
}

/**
 * `alt+h/j/k/l` resize: shift the active pane's share inside the nearest
 * split along that axis (`row` for h/l, `column` for j/k) one step in `sign`.
 * The weights stay relative, so it can never overshoot a sibling.
 */
function resizeWeights(
  node: PaneNode,
  paneId: string,
  axis: "row" | "column",
  sign: 1 | -1,
): PaneNode {
  let done = false;
  const walkDown = (n: PaneNode): PaneNode => {
    if (n.kind === "leaf") return n;
    const children = n.children.map((child) =>
      containsPane(child, paneId) ? walkDown(child) : child,
    );
    if (n.dir === axis && !done) {
      const index = children.findIndex((child) => containsPane(child, paneId));
      if (index >= 0) {
        const weights = [...n.weights];
        weights[index] = Math.max((weights[index] ?? 1) + sign, 0.05);
        const sum = weights.reduce((a, b) => a + b, 0);
        done = true;
        return { ...n, children, weights: weights.map((w) => w / sum) };
      }
    }
    return { ...n, children };
  };
  return walkDown(node);
}

/**
 * vim's `ctrl+w h/j/k/l`: the pane adjacent to `paneId` along `dir`, taken
 * from the nearest ancestor split on that axis (leaf-most first), reaching the
 * far leaf of the adjacent group. `null` when there is no neighbour on that
 * side anywhere up the tree.
 */
function neighborPane(
  node: PaneNode,
  paneId: string,
  dir: "h" | "j" | "k" | "l",
): string | null {
  const forward = dir === "l" || dir === "j";
  const axis = dir === "h" || dir === "l" ? "row" : "column";

  // The ancestor chain of the pane, leaf-most first.
  const chain: PaneNode[] = [];
  const collect = (n: PaneNode): boolean => {
    if (n.kind === "leaf") return n.pane.id === paneId;
    for (const child of n.children) {
      if (collect(child)) {
        chain.push(n);
        return true;
      }
    }
    return false;
  };
  if (!collect(node)) return null;

  for (const ancestor of chain) {
    if (ancestor.kind !== "split" || ancestor.dir !== axis) continue;
    const index = ancestor.children.findIndex((child) =>
      containsPane(child, paneId),
    );
    const pool = forward
      ? ancestor.children.slice(index + 1)
      : ancestor.children.slice(0, index).reverse();
    for (const sibling of pool) {
      const ids = orderedPaneIds(sibling);
      if (ids.length === 0) continue;
      // Travel direction picks the extreme leaf of the group: h/k take the
      // far (right/bottom) edge of the left/top neighbour, l/j the near
      // (left/top) edge of the right/bottom neighbour.
      return forward ? ids[0]! : ids[ids.length - 1]!;
    }
  }
  return null;
}

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
 * the `ctrl+w` leader (plus `alt+h/j/k/l` for resizing). The tab owns the
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
  onResize: (axis: "row" | "column", sign: 1 | -1) => void;
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
        keys: ["alt+h"],
        help: { keys: "alt+h", label: "Shrink width" },
        run: () => onResize("row", -1),
      },
      {
        keys: ["alt+l"],
        help: { keys: "alt+l", label: "Grow width" },
        run: () => onResize("row", 1),
      },
      {
        keys: ["alt+j"],
        help: { keys: "alt+j", label: "Shrink height" },
        run: () => onResize("column", -1),
      },
      {
        keys: ["alt+k"],
        help: { keys: "alt+k", label: "Grow height" },
        run: () => onResize("column", 1),
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
  tabs,
  activeId,
  onActivate,
}: {
  tabs: Tab[];
  activeId: string;
  onActivate: (tab: Tab) => void;
}) {
  const toggleHelp = useToggleHelp();

  return (
    <nav className="flex items-center gap-1 border-t px-2 py-1">
      {tabs.map((tab, i) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onActivate(tab)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "px-2 py-0.5",
              active
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            [{i + 1} {tabLabel(tab)}]
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
 * One pane: a header row of its own (portal for `ShellHeader`), then the page
 * inside the pane's own scroll box, backed by the pane's own in-memory
 * router. The router is created once and lives as long as the pane mounts —
 * a tab switch may hide it, a split may re-render around it, but its session
 * and history survive until the pane is truly closed.
 */
function PaneFrame({
  pane,
  focused,
  onFocus,
  onNavigate,
  registerRouter,
}: {
  pane: Pane;
  focused: boolean;
  onFocus: () => void;
  onNavigate: (pageId: string, to: string) => void;
  registerRouter: (router: PaneRouter | null) => void;
}) {
  // Created once, from the pane's recorded location at mount.
  const [router] = useState(() =>
    createMemoryRouter(APP_ROUTES, { initialEntries: [pane.to] }),
  );
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  // The shell reaches into this pane's router (opening a page from the tabs
  // popup, aiming a fresh chat pane at its new session) through the router
  // registry, kept in step with the pane's lifetime.
  useEffect(() => {
    registerRouter(router);
    return () => registerRouter(null);
  }, [router, registerRouter]);

  // The pane's recorded `to` is the shell's truth for where it should be;
  // when it changes (a fresh session, a page opened in the pane), follow it.
  // After that the pane's own router is authoritative: an in-pane navigation
  // is recorded back through onNavigate.
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
      const pageId =
        PAGES.find((page) => page.href === state.location.pathname)?.id ??
        PAGES[0]!.id;
      if (pageId !== pane.pageId || to !== pane.to) onNavigate(pageId, to);
    });
  }, [router, pane.pageId, pane.to, onNavigate]);

  return (
    <div
      onMouseDownCapture={onFocus}
      className={cn(
        "flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        focused && "ring-1 ring-inset ring-muted-foreground/40",
      )}
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
  );
}

/**
 * The pane tree. Splits are flex containers; every child (a pane or a nested
 * split) is a flex item sized by its weight, and the 1px gap in the split's
 * own chrome doubles as the divider line.
 */
function PaneNodeView({
  node,
  activePaneId,
  onFocus,
  onNavigate,
  registerRouter,
}: {
  node: PaneNode;
  activePaneId: string;
  onFocus: (paneId: string) => void;
  onNavigate: (paneId: string, pageId: string, to: string) => void;
  registerRouter: (paneId: string, router: PaneRouter | null) => void;
}) {
  if (node.kind === "leaf") {
    return (
      <PaneFrame
        pane={node.pane}
        focused={node.pane.id === activePaneId}
        onFocus={() => onFocus(node.pane.id)}
        onNavigate={(pageId, to) => onNavigate(node.pane.id, pageId, to)}
        registerRouter={(router) => registerRouter(node.pane.id, router)}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex h-full w-full min-h-0 min-w-0 gap-px bg-border",
        node.dir === "row" ? "flex-row" : "flex-col",
      )}
    >
      {node.children.map((child, i) => (
        <div
          key={child.id}
          className={cn(
            "min-h-0 min-w-0",
            node.dir === "row" ? "h-full" : "w-full",
          )}
          style={{ flexGrow: node.weights[i] ?? 1, flexBasis: 0 }}
        >
          <PaneNodeView
            node={child}
            activePaneId={activePaneId}
            onFocus={onFocus}
            onNavigate={onNavigate}
            registerRouter={registerRouter}
          />
        </div>
      ))}
    </div>
  );
}

export function AppShell() {
  const [tabs, setTabs] = useState<Tab[]>([STARTUP_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>(STARTUP_TAB.id);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Whether the rename-tab dialog is up, over the popup layer. */
  const [renaming, setRenaming] = useState(false);
  /** Every live pane's router, keyed `tabId:paneId`, so the shell can
   *  navigate a pane from outside of it. */
  const routers = useRef(new Map<string, PaneRouter>());
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const activeIndex = Math.max(
    tabs.findIndex((tab) => tab.id === activeTabId),
    0,
  );

  // The startup tab is a fresh chat: create a session the shell has never
  // shown and point the startup pane at it, so boot is a brand-new session
  // rather than the most recently modified one. The claim only sticks while
  // the pane still sits on the untouched chat home page.
  useEffect(() => {
    let cancelled = false;
    void window.api.chat.createChatSession("New chat").then((result) => {
      if (cancelled || result.error || !result.id) return;
      const to = `/chat?session=${encodeURIComponent(result.id)}`;
      const stillUnclaimed = tabsRef.current.some((tab) => {
        if (tab.id !== STARTUP_TAB.id) return false;
        const pane = leafOf(tab.root, tab.activePaneId);
        return (
          pane !== null &&
          pane.pageId === PAGES[0]!.id &&
          pane.to === PAGES[0]!.href
        );
      });
      if (!stillUnclaimed) return;
      setTabs((entries) =>
        entries.map((tab) =>
          tab.id === STARTUP_TAB.id
            ? { ...tab, root: setPaneTo(tab.root, tab.activePaneId, to) }
            : tab,
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Focus `paneId` inside `tabId`, bringing that tab to the front. */
  const focusPane = useCallback((tabId: string, paneId: string) => {
    setActiveTabId(tabId);
    setTabs((entries) =>
      entries.map((tab) =>
        tab.id === tabId ? { ...tab, activePaneId: paneId } : tab,
      ),
    );
  }, []);

  /** Called by a pane whenever its own router lands somewhere brand-new. */
  const onPaneNavigate = useCallback(
    (tabId: string, paneId: string, pageId: string, to: string) => {
      setTabs((entries) =>
        entries.map((tab) => {
          if (tab.id !== tabId) return tab;
          if (!leafOf(tab.root, paneId)) return tab;
          return { ...tab, root: setPaneRecord(tab.root, paneId, pageId, to) };
        }),
      );
    },
    [],
  );

  /** The pane registry: register/deregister a pane's router. */
  const registerRouter = useCallback(
    (tabId: string, paneId: string, router: PaneRouter | null) => {
      const key = `${tabId}:${paneId}`;
      if (router) routers.current.set(key, router);
      else routers.current.delete(key);
    },
    [],
  );

  /** `tab`/`space`'s result and the tab bar's click: show the tab. Nothing
   *  else happens — the pane tree was already alive underneath. */
  const activate = useCallback((tab: Tab) => {
    setActiveTabId(tab.id);
  }, []);

  const switchTab = useCallback(
    (delta: number) => {
      if (tabs.length === 0) return;
      const next = tabs[(activeIndex + delta + tabs.length) % tabs.length]!;
      activate(next);
    },
    [tabs, activeIndex, activate],
  );

  /** The popup's number keys: jump to a tab and close the popup. */
  const switchToNumber = useCallback(
    (index: number) => {
      const tab = tabs[index];
      if (!tab) return;
      setPickerOpen(false);
      activate(tab);
    },
    [tabs, activate],
  );

  /** `d` in the popup: close the active tab, landing on its right neighbour
   *  (or left, at the end). The last tab never closes. */
  const closeTab = useCallback(() => {
    if (tabs.length <= 1) return;
    const index = activeIndex;
    const next = tabs[index + 1] ?? tabs[index - 1] ?? tabs[0];
    setTabs((entries) => entries.filter((tab) => tab.id !== activeTabId));
    setPickerOpen(false);
    if (next) setActiveTabId(next.id);
  }, [tabs, activeIndex, activeTabId]);

  /** Aim `paneId` of `tabId` at a brand-new empty chat session. */
  const aimAtFreshChat = useCallback((tabId: string, paneId: string) => {
    void window.api.chat.createChatSession("New chat").then((result) => {
      if (result.error || !result.id) return;
      const to = `/chat?session=${encodeURIComponent(result.id)}`;
      setTabs((entries) =>
        entries.map((tab) =>
          tab.id !== tabId
            ? tab
            : { ...tab, root: retargetLeaf(tab.root, paneId, to) },
        ),
      );
    });
  }, []);

  /** `n` in the popup: a fresh tab on a brand-new empty session, activated at
   *  once. The tab appears immediately on the chat home page and
   *  `aimAtFreshChat` points its pane at the new session when it lands, so a
   *  failed session creation still leaves a usable chat tab. */
  const newTab = useCallback(() => {
    setPickerOpen(false);
    const paneId = `pane-${crypto.randomUUID()}`;
    const tab: Tab = {
      id: `tab-${crypto.randomUUID()}`,
      root: {
        kind: "leaf",
        id: paneId,
        pane: { id: paneId, pageId: PAGES[0]!.id, to: PAGES[0]!.href },
      },
      activePaneId: paneId,
    };
    setTabs((entries) => [...entries, tab]);
    setActiveTabId(tab.id);
    aimAtFreshChat(tab.id, paneId);
  }, [aimAtFreshChat]);

  /** `ctrl+w v` / `ctrl+w s`: split the active pane and move to the fresh
   *  one. A chat split also spawns the new pane's own session. */
  const splitActivePane = useCallback(
    (dir: "row" | "column") => {
      const tab = tabs.find((entry) => entry.id === activeTabId) ?? tabs[0];
      if (!tab) return;
      const { node, freshId } = splitLeaf(tab.root, tab.activePaneId, dir);
      const pane = leafOf(tab.root, tab.activePaneId);
      const chatSplit = pane?.pageId === PAGES[0]!.id;
      setTabs((entries) =>
        entries.map((entry) =>
          entry.id === tab.id
            ? { ...entry, root: node, activePaneId: freshId }
            : entry,
        ),
      );
      if (chatSplit) aimAtFreshChat(tab.id, freshId);
    },
    [tabs, activeTabId, aimAtFreshChat],
  );

  /** `ctrl+w h/j/k/l` (and `ctrl+w ctrl+w`): move pane focus. */
  const movePane = useCallback(
    (dir: "h" | "j" | "k" | "l" | "next") => {
      const tab = tabs.find((entry) => entry.id === activeTabId) ?? tabs[0];
      if (!tab) return;
      if (dir === "next") {
        const ids = orderedPaneIds(tab.root);
        const i = ids.indexOf(tab.activePaneId);
        const next = ids[(i + 1) % ids.length];
        if (next) focusPane(tab.id, next);
        return;
      }
      const next = neighborPane(tab.root, tab.activePaneId, dir);
      if (next) focusPane(tab.id, next);
    },
    [tabs, activeTabId, focusPane],
  );

  /** `alt+h/j/k/l`: resize the active pane along that axis. */
  const resizePane = useCallback(
    (axis: "row" | "column", sign: 1 | -1) => {
      const tab = tabs.find((entry) => entry.id === activeTabId) ?? tabs[0];
      if (!tab) return;
      const root = resizeWeights(tab.root, tab.activePaneId, axis, sign);
      setTabs((entries) =>
        entries.map((entry) =>
          entry.id === tab.id ? { ...entry, root } : entry,
        ),
      );
    },
    [tabs, activeTabId],
  );

  /** `ctrl+w q`: close the active pane, focusing the tree's first survivor.
   *  A tab's last pane closing is the tab closing (like `d` in the popup). */
  const closePane = useCallback(() => {
    const tab = tabs.find((entry) => entry.id === activeTabId) ?? tabs[0];
    if (!tab) return;
    if (orderedPaneIds(tab.root).length <= 1) {
      closeTab();
      return;
    }
    const root = removePane(tab.root, tab.activePaneId);
    if (!root) return;
    const next = orderedPaneIds(root)[0] ?? null;
    setTabs((entries) =>
      entries.map((entry) =>
        entry.id === tab.id
          ? { ...entry, root, activePaneId: next ?? entry.activePaneId }
          : entry,
      ),
    );
  }, [tabs, activeTabId, closeTab]);

  /** `r` in the popup: a custom label for the active tab. Clearing it falls
   *  back to the active pane's page name. */
  const renameTab = useCallback(
    (label: string) => {
      const trimmed = label.trim();
      setTabs((entries) =>
        entries.map((tab) =>
          tab.id === activeTabId
            ? { ...tab, label: trimmed || undefined }
            : tab,
        ),
      );
    },
    [activeTabId],
  );

  /** The popup's pages open in the active *pane*, which has its own page and
   *  router now. Navigate the pane's router; it records the new page itself. */
  const openPageInPane = useCallback(
    (page: Page) => {
      setPickerOpen(false);
      const tab = tabs.find((entry) => entry.id === activeTabId) ?? tabs[0];
      if (!tab) return;
      const pane = leafOf(tab.root, tab.activePaneId);
      if (!pane || pane.pageId === page.id) return;
      const router = routers.current.get(`${tab.id}:${pane.id}`);
      router?.navigate(page.href);
    },
    [tabs, activeTabId],
  );

  const pickerItems: KeyMenuItem[] = [
    {
      key: "n",
      label: "New tab",
      run: newTab,
    },
    {
      label: "Rename tab",
      detail: activeTab ? tabLabel(activeTab) : undefined,
      run: () => {
        setPickerOpen(false);
        setRenaming(true);
      },
    },
    {
      key: "d",
      label: "Close tab",
      detail: activeTab ? tabLabel(activeTab) : undefined,
      destructive: true,
      run: () => closeTab(),
    },
    ...PAGES.map((page) => ({
      key: page.key,
      label: page.label,
      detail: "Open in this pane",
      run: () => openPageInPane(page),
    })),
  ];

  return (
    <KeymapProvider>
      <SettingsProvider>
        <PaneMode
          onSplit={splitActivePane}
          onMove={movePane}
          onResize={resizePane}
          onClosePane={closePane}
        />
        <NormalMode
          onOpenTabs={() => setPickerOpen(true)}
          onSwitch={switchTab}
        />

        {/* The pane area: every tab's tree stays mounted; hidden ones merely
            lie `display:none`, so a tab switch never costs a session reload. */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "h-full min-h-0 w-full",
                activeTabId === tab.id ? "flex flex-col" : "hidden",
              )}
            >
              <PaneNodeView
                node={tab.root}
                activePaneId={tab.activePaneId}
                onFocus={(paneId) => focusPane(tab.id, paneId)}
                onNavigate={(paneId, pageId, to) =>
                  onPaneNavigate(tab.id, paneId, pageId, to)
                }
                registerRouter={(paneId, router) =>
                  registerRouter(tab.id, paneId, router)
                }
              />
            </div>
          ))}
        </div>
        <TabBar tabs={tabs} activeId={activeTabId} onActivate={activate} />
        {pickerOpen ? (
          <KeyMenu
            id="tabs"
            title="Tabs"
            meta={activeTab ? tabLabel(activeTab) : undefined}
            items={pickerItems}
            hint="NUM — switch to a tab"
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
        {pickerOpen ? (
          <TabNumbers count={tabs.length} onPick={switchToNumber} />
        ) : null}
        {renaming && activeTab ? (
          <FieldEditor
            id="rename-tab"
            title={`Rename ${tabLabel(activeTab)}`}
            field={{
              name: "label",
              label: "tab label",
              value: tabLabel(activeTab),
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
      </SettingsProvider>
    </KeymapProvider>
  );
}