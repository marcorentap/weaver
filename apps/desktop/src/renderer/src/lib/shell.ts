import { PAGES } from "@/lib/pages";

/**
 * The shell's layout model: tabs, and each tab's tree of panes. This is the
 * single source of truth for *where* things are — one reducer owns it, and
 * every structural change (split, close, focus, resize, tab switch) is a
 * pure step in that reducer, so there is exactly one code path and no
 * hand-rolled `setState` soup for key handling to drift from.
 *
 * What lives in a page (its graph, its session, its scroll, its local mode)
 * does NOT live here. Panes only carry identity (`id`), which page is open
 * (`pageId`) and where in that page (`to`); the page itself is mounted by
 * the shell's pane pool, keyed by `pane.id`, and keeps its state for as
 * long as the pane exists.
 */

export type PaneId = string;
export type TabId = string;

/** One pane slot: owns a page outright. `pageId` is the page currently
 *  rendering (the tab bar's label follows the active pane), `to` its in-pane
 *  location, query string included, so a chat pane keeps its session's URL
 *  when the page navigates under it. */
export type Pane = { id: PaneId; pageId: string; to: string };

/**
 * A tab's pane tree. Leaves are panes; splits hold two or more children
 * along one axis (`row` = side-by-side across a vertical dividing line,
 * vim's vertical split; `column` = stacked, vim's horizontal split).
 * `weights` are each child's share of the split, nudged by `alt+h/j/k/l`.
 * The tree is pure geometry and identity — real page state lives outside it,
 * keyed by pane id, so reshaping the tree never has to remount a page.
 */
export type PaneNode =
  | { kind: "leaf"; pane: Pane }
  | {
      kind: "split";
      id: string;
      dir: "row" | "column";
      weights: number[];
      children: PaneNode[];
    };

/** One open tab. A tab owns its pane tree; switching tabs never touches the
 *  panes, it just shows a different tree. `label` names the tab itself, set
 *  with `r` in the popup; blank falls back to the active pane's page name.
 *  `activePaneId` is the pane keyboard focus sits in. */
export type Tab = { id: TabId; label?: string; root: PaneNode; activePaneId: PaneId };

export type Layout = { tabs: Tab[]; activeTabId: TabId };

// ---- page identity -------------------------------------------------------

/** The page id of the chat home — where a fresh, session-less pane points. */
export const CHAT_PAGE = PAGES[0]!;

export function pageLabelOf(pageId: string): string {
  return PAGES.find((page) => page.id === pageId)?.label ?? pageId;
}

export function tabLabelOf(tab: Tab): string {
  const pane = activePaneOf(tab.root, tab.activePaneId);
  return tab.label ?? (pane ? pageLabelOf(pane.pageId) : "…");
}

export function isChatHome(pane: Pane): boolean {
  return pane.pageId === CHAT_PAGE.id && pane.to === CHAT_PAGE.href;
}

// ---- factories -----------------------------------------------------------

export function newPaneId(): PaneId {
  return `pane-${crypto.randomUUID()}`;
}

export function makePane(pageId: string, to: string): Pane {
  return { id: newPaneId(), pageId, to };
}

/** A brand-new tab with a single pane on the chat home page (no session
 *  yet — the shell aims it at a fresh session as the session creation
 *  resolves). */
export function makeTab(): Tab {
  const pane = makePane(CHAT_PAGE.id, CHAT_PAGE.href);
  return {
    id: `tab-${crypto.randomUUID()}`,
    root: { kind: "leaf", pane },
    activePaneId: pane.id,
  };
}

// ---- tree queries --------------------------------------------------------

/** The pane with `id`, or null when it isn't under `node`. */
export function findPane(node: PaneNode, paneId: PaneId): Pane | null {
  if (node.kind === "leaf") return node.pane.id === paneId ? node.pane : null;
  for (const child of node.children) {
    const found = findPane(child, paneId);
    if (found) return found;
  }
  return null;
}

export function containsPane(node: PaneNode, paneId: PaneId): boolean {
  return findPane(node, paneId) !== null;
}

/** Every leaf pane, in tree order (left to right, top to bottom). The flat
 *  order doubles as the render order of the shell's pane pool. */
export function orderedPanes(node: PaneNode): Pane[] {
  if (node.kind === "leaf") return [node.pane];
  const out: Pane[] = [];
  for (const child of node.children) out.push(...orderedPanes(child));
  return out;
}

/** The active leaf's pane for a tab, or null if the tree was emptied. */
export function activePaneOf(root: PaneNode, activePaneId: PaneId): Pane | null {
  return findPane(root, activePaneId);
}

/** Replace a pane's recorded location in the tree, keeping its page. The
 *  pane component follows it and navigates its own router there. */
export function setPaneTo(node: PaneNode, paneId: PaneId, to: string): PaneNode {
  if (node.kind === "leaf") {
    if (node.pane.id !== paneId) return node;
    return { ...node, pane: { ...node.pane, to } };
  }
  return {
    ...node,
    children: node.children.map((child) => setPaneTo(child, paneId, to)),
  };
}

/** Replace both the page and the recorded location (an in-pane navigation
 *  reported back by the page's router). */
export function setPaneRecord(
  node: PaneNode,
  paneId: PaneId,
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

/**
 * Turn `paneId`'s leaf into a split holding the original pane and the given
 * fresh one along `dir`. The fresh pane is supplied by the caller (which
 * decides its page); a chat pane starts on the chat home page and its
 * brand-new session arrives a moment later (via the `retarget-pane` action),
 * so a split never mounts two live graphs on the same session.
 */
export function splitLeaf(
  node: PaneNode,
  paneId: PaneId,
  dir: "row" | "column",
  fresh: Pane,
): PaneNode {
  const walk = (n: PaneNode): PaneNode => {
    if (n.kind === "leaf") {
      if (n.pane.id !== paneId) return n;
      // New panes go right (`row`) / below (`column`), and the fresh one
      // takes the cursor, exactly like vim's `ctrl+w v` / `ctrl+w s`.
      return {
        kind: "split",
        id: `split-${crypto.randomUUID()}`,
        dir,
        weights: [1, 1],
        children: [n, { kind: "leaf", pane: fresh }],
      };
    }
    const children = n.children.map((child) => walk(child));
    return { ...n, children };
  };
  return walk(node);
}

/** Drop `paneId`'s leaf, collapsing any split left with a single child. */
export function removeLeaf(node: PaneNode, paneId: PaneId): PaneNode | null {
  if (node.kind === "leaf") return node.pane.id === paneId ? null : node;
  const children = node.children
    .map((child) => removeLeaf(child, paneId))
    .filter((child): child is PaneNode => child !== null);
  if (children.length === node.children.length) return node;
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children };
}

/**
 * `alt+h/j/k/l` resize: shift the active pane's share inside the nearest
 * split along that axis (`row` for h/l, `column` for j/k) one step in
 * `sign`. The weights stay relative, so it can never overshoot a sibling.
 */
export function resizeWeights(
  node: PaneNode,
  paneId: PaneId,
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
 * from the nearest ancestor split on that axis (leaf-most first), reaching
 * the far leaf of the adjacent group. `null` when there's no neighbour on
 * that side anywhere up the tree.
 */
export function neighborPane(
  node: PaneNode,
  paneId: PaneId,
  dir: "h" | "j" | "k" | "l",
): PaneId | null {
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
      const ids = orderedPanes(sibling).map((p) => p.id);
      if (ids.length === 0) continue;
      // Travel direction picks the extreme leaf of the group: h/k take the
      // far (right/bottom) edge of the left/top neighbour, l/j the near
      // (left/top) edge of the right/bottom neighbour.
      return forward ? ids[0]! : ids[ids.length - 1]!;
    }
  }
  return null;
}

// ---- geometry -------------------------------------------------------------

export type PaneRect = { left: number; top: number; width: number; height: number };

/**
 * The pane tree laid out as absolute rectangles, each as a % share of the
 * whole pane area. The shell positions its flat pane pool with these, so the
 * page instances themselves don't move in the DOM when the tree reshapes.
 */
export function paneGeometry(node: PaneNode): Map<PaneId, PaneRect> {
  const out = new Map<PaneId, PaneRect>();
  const walk = (n: PaneNode, rect: PaneRect) => {
    if (n.kind === "leaf") {
      out.set(n.pane.id, rect);
      return;
    }
    const sum = n.weights.reduce((a, b) => a + b, 0) || 1;
    let offset = 0;
    n.children.forEach((child, i) => {
      const share = ((n.weights[i] ?? 1) / sum) * 100;
      if (n.dir === "row") {
        walk(child, { ...rect, left: rect.left + offset, width: share });
      } else {
        walk(child, { ...rect, top: rect.top + offset, height: share });
      }
      offset += share;
    });
  };
  walk(node, { left: 0, top: 0, width: 100, height: 100 });
  return out;
}

// ---- reducer ---------------------------------------------------------------

export type ShellAction =
  | { type: "activate-tab"; tabId: TabId }
  | { type: "new-tab"; tab: Tab }
  | { type: "close-tab"; tabId: TabId }
  | { type: "rename-tab"; label?: string }
  /** Focus `paneId` wherever it is; its tab comes to the front too. */
  | { type: "focus-pane"; paneId: PaneId }
  | { type: "split-pane"; dir: "row" | "column"; fresh: Pane }
  /** Close the active tab pane (pane focus included). */
  | { type: "close-pane" }
  | { type: "move-focus"; dir: "h" | "j" | "k" | "l" | "next" }
  | { type: "resize-pane"; axis: "row" | "column"; sign: 1 | -1 }
  /** A pane's router landed somewhere brand-new; keep the tab's record in
   *  step (drives the tab label). */
  | { type: "record-pane"; paneId: PaneId; pageId: string; to: string }
  /** Aim the pane at `to`, but only while it still sits on the chat home
   *  page — a fresh session landing late never yanks a pane the user
   *  already moved. */
  | { type: "retarget-pane"; paneId: PaneId; to: string };

/** The startup layout is a single tab with a single chat pane: nothing else.
 *  A pane holds no session yet — the shell aims it at a brand-new one on
 *  mount, so boot is always a fresh chat, never someone else's (or last
 *  run's) last one. */
export function initialLayout(): Layout {
  const tab = makeTab();
  return { tabs: [tab], activeTabId: tab.id };
}

function activeTabOf(layout: Layout): Tab | undefined {
  return layout.tabs.find((tab) => tab.id === layout.activeTabId) ?? layout.tabs[0];
}

function mapTab(layout: Layout, tabId: TabId, update: (tab: Tab) => Tab): Layout {
  return {
    ...layout,
    tabs: layout.tabs.map((tab) => (tab.id === tabId ? update(tab) : tab)),
  };
}

/** Apply `update` to every tab whose tree touches `paneId`. */
function mapTabWithPane(
  layout: Layout,
  paneId: PaneId,
  update: (tab: Tab, root: PaneNode) => Tab,
): Layout {
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      containsPane(tab.root, paneId) ? update(tab, tab.root) : tab,
    ),
  };
}

export function reduceLayout(layout: Layout, action: ShellAction): Layout {
  switch (action.type) {
    case "activate-tab": {
      if (!layout.tabs.some((tab) => tab.id === action.tabId)) return layout;
      return { ...layout, activeTabId: action.tabId };
    }

    case "new-tab": {
      return { ...layout, tabs: [...layout.tabs, action.tab], activeTabId: action.tab.id };
    }

    case "close-tab": {
      if (layout.tabs.length <= 1) return layout; // the last tab never closes
      const index = layout.tabs.findIndex((tab) => tab.id === action.tabId);
      if (index < 0) return layout;
      const tabs = layout.tabs.filter((tab) => tab.id !== action.tabId);
      const next = tabs[index] ?? tabs[index - 1] ?? tabs[0];
      return { tabs, activeTabId: next!.id };
    }

    case "rename-tab": {
      const active = activeTabOf(layout);
      if (!active) return layout;
      return mapTab(layout, active.id, (tab) => ({
        ...tab,
        label: action.label?.trim() || undefined,
      }));
    }

    case "focus-pane": {
      const owner = layout.tabs.find((tab) => containsPane(tab.root, action.paneId));
      if (!owner) return layout;
      return {
        ...layout,
        activeTabId: owner.id,
        tabs: layout.tabs.map((tab) =>
          tab.id === owner.id ? { ...tab, activePaneId: action.paneId } : tab,
        ),
      };
    }

    case "split-pane": {
      const active = activeTabOf(layout);
      if (!active) return layout;
      const root = splitLeaf(active.root, active.activePaneId, action.dir, action.fresh);
      return mapTab(layout, active.id, (tab) => ({
        ...tab,
        root,
        activePaneId: action.fresh.id,
      }));
    }

    case "close-pane": {
      const active = activeTabOf(layout);
      if (!active) return layout;
      const leaves = orderedPanes(active.root);
      // The last pane of the active tab closes the tab itself.
      if (leaves.length <= 1) {
        return reduceLayout(layout, { type: "close-tab", tabId: active.id });
      }
      const root = removeLeaf(active.root, active.activePaneId);
      if (!root) return layout;
      const next = orderedPanes(root)[0];
      return mapTab(layout, active.id, (tab) => ({
        ...tab,
        root,
        activePaneId: next?.id ?? tab.activePaneId,
      }));
    }

    case "move-focus": {
      const active = activeTabOf(layout);
      if (!active) return layout;
      let next: PaneId | null;
      if (action.dir === "next") {
        const ids = orderedPanes(active.root).map((p) => p.id);
        const i = ids.indexOf(active.activePaneId);
        next = ids[(i + 1) % ids.length] ?? null;
      } else {
        next = neighborPane(active.root, active.activePaneId, action.dir);
      }
      if (!next) return layout;
      return mapTab(layout, active.id, (tab) => ({ ...tab, activePaneId: next }));
    }

    case "resize-pane": {
      const active = activeTabOf(layout);
      if (!active) return layout;
      const root = resizeWeights(active.root, active.activePaneId, action.axis, action.sign);
      return mapTab(layout, active.id, (tab) => ({ ...tab, root }));
    }

    case "record-pane": {
      return mapTabWithPane(layout, action.paneId, (tab, root) => {
        const pane = findPane(root, action.paneId);
        if (!pane || (pane.pageId === action.pageId && pane.to === action.to)) {
          return tab;
        }
        return {
          ...tab,
          root: setPaneRecord(root, action.paneId, action.pageId, action.to),
        };
      });
    }

    case "retarget-pane": {
      return mapTabWithPane(layout, action.paneId, (tab, root) => {
        const pane = findPane(root, action.paneId);
        if (!pane || !isChatHome(pane)) return tab;
        return { ...tab, root: setPaneTo(root, action.paneId, action.to) };
      });
    }
  }
}