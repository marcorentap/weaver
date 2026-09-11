import { createContext, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
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
import { cn } from "@/lib/utils";

/**
 * The shell's own header region. A page fills it through `ShellHeader`, so its
 * bar is a sibling of the tab bar rather than the first row of the scrolling
 * content. Both stay put, and only what is between them moves.
 */
const headerSlot = createContext<HTMLElement | null>(null);

export function ShellHeader({ children }: { children: React.ReactNode }) {
  const node = useContext(headerSlot);
  return node ? createPortal(children, node) : null;
}

/**
 * One open tab. A tab is a generic slot, not tied to a page: it can hold any
 * page in the registry, changed from the `tab`/`space` popup, so "1 is chat,
 * 2 is resources" is gone. `to` is the tab's own location, query string included,
 * so a chat tab keeps its session when its URL moves under it; `pageId` is
 * the page currently rendering in it, for the tab bar's label. An optional
 * `label` names the tab itself, set with `r` in the popup; blank falls back
 * to the page's name.
 */
type Tab = { id: string; pageId: string; to: string; label?: string };

/** The startup layout is a single tab: chat, nothing else. Resources and
 *  Settings are no longer open at boot; they stay reachable through the
 *  `tab`/`space` popup, but the app starts with exactly one tab. It holds no
 *  session yet — `AppShell` points it at a brand-new one on mount, so boot
 *  is always a fresh chat, never someone else's (or last run's) last one. */
const STARTUP_TAB: Tab = {
  id: PAGES[0]!.id,
  pageId: PAGES[0]!.id,
  to: PAGES[0]!.href,
};

function tabLabel(tab: Tab): string {
  return (
    tab.label ??
    PAGES.find((page) => page.id === tab.pageId)?.label ??
    tab.pageId
  );
}

/**
 * Normal mode is the bottom of the keymap stack, live everywhere. Page layers
 * stack on top of it, so tab switching keeps working inside a page's mode and
 * stops only inside a modal popup.
 */
function NormalMode({
  onOpenTabs,
  onSwitch,
}: {
  /** `tab` or `space`: open the tabs popup, like chat's sessions menu. */
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
 *  tabs' own indexes, `1` through however many are open. */
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
          <Link
            key={tab.id}
            to={tab.to}
            // `to` renders the right href, but the click itself must also
            // mark the tab active, else the active-tab URL effect would
            // claim the destination for whichever tab is currently active.
            onClick={(event) => {
              event.preventDefault();
              onActivate(tab);
            }}
            aria-current={active ? "page" : undefined}
            className={cn(
              "px-2 py-0.5",
              active
                ? "font-medium text-white"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            [{i + 1} {tabLabel(tab)}]
          </Link>
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([STARTUP_TAB]);
  const [activeId, setActiveId] = useState<string>(STARTUP_TAB.id);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Whether the rename-tab dialog is up, over the popup layer. */
  const [renaming, setRenaming] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // The startup tab is a fresh chat: create a session the shell has never
  // shown and point the startup tab at it. Starting at the chat home page
  // means `/chat` would silently fall back to the most recently modified
  // session; navigating to the new session's own URL avoids that, and the
  // location effect below records it into the tab, so switching away and
  // back returns to this new session rather than resuming an old one.
  useEffect(() => {
    let cancelled = false;
    void window.api.chat.createChatSession("New chat").then((result) => {
      if (cancelled || result.error || !result.id) return;
      const to = `/chat?session=${encodeURIComponent(result.id)}`;
      setTabs((entries) =>
        entries.map((tab) =>
          tab.id === STARTUP_TAB.id ? { ...tab, to } : tab,
        ),
      );
      navigate(to);
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const activeIndex = Math.max(
    tabs.findIndex((tab) => tab.id === activeId),
    0,
  );
  const activeTab = tabs[activeIndex] ?? tabs[0];

  // The active tab owns the URL. Whatever that tab's own navigation lands on
  // — a session link inside chat, a page picked from `space`, anything a
  // future page routes to — is written back into the tab, so switching away
  // and back returns to exactly that state. Switching tabs navigates to the
  // new tab's own stored location, which this effect then re-records as the
  // same value, a no-op.
  useEffect(() => {
    const current = location.pathname + location.search;
    // The synchronous write is deliberate: the location is the external
    // system here, and the effect is what synchronizes the active tab's
    // stored URL with it, the one place a visited URL can land.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTabs((entries) =>
      entries.map((tab) =>
        tab.id === activeId ? { ...tab, to: current } : tab,
      ),
    );
  }, [location.pathname, location.search, activeId]);

  /** Follows `tab` by activating it and navigating to its own location. */
  const activate = (tab: Tab) => {
    setActiveId(tab.id);
    navigate(tab.to);
  };

  const switchTab = (delta: number) => {
    if (tabs.length === 0) return;
    const next = tabs[(activeIndex + delta + tabs.length) % tabs.length]!;
    activate(next);
  };

  /** `space`'s result: the active tab becomes `page` and follows it. Picking
   *  the page it already shows is a no-op, so a chat tab's own `?session=`
   *  is never wiped by re-picking Chat. */
  const openPage = (page: Page) => {
    setPickerOpen(false);
    if (!activeTab || page.id === activeTab.pageId) return;
    setTabs((entries) =>
      entries.map((tab) =>
        tab.id === activeId ? { ...tab, pageId: page.id, to: page.href } : tab,
      ),
    );
    navigate(page.href);
  };

  /** `n` in the popup: a fresh tab on the home page, activated at once. */
  const newTab = () => {
    const page = PAGES[0]!;
    const tab: Tab = {
      id: crypto.randomUUID(),
      pageId: page.id,
      to: page.href,
    };
    setTabs((entries) => [...entries, tab]);
    setPickerOpen(false);
    setActiveId(tab.id);
    navigate(page.href);
  };

  /** `r` in the popup: a custom label for the active tab. Clearing it falls
   *  back to the page's own name. */
  const renameTab = (label: string) => {
    const trimmed = label.trim();
    setTabs((entries) =>
      entries.map((tab) =>
        tab.id === activeId ? { ...tab, label: trimmed || undefined } : tab,
      ),
    );
  };

  /** `d` in the popup: close the active tab, landing on its right neighbour
   *  (or left, at the end). The last tab never closes, so the shell always
   *  has something to show. */
  const closeTab = () => {
    if (tabs.length <= 1) return;
    const index = activeIndex;
    const next = tabs[index + 1] ?? tabs[index - 1] ?? tabs[0];
    setTabs((entries) => entries.filter((tab) => tab.id !== activeId));
    setPickerOpen(false);
    if (next) {
      setActiveId(next.id);
      navigate(next.to);
    }
  };

  /** A number while the popup is up: jump to that tab and close the popup. */
  const switchToNumber = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    setPickerOpen(false);
    activate(tab);
  };

  // The popup `tab`/`space` opens, the shell's answer to chat's sessions
  // menu. Like sessions, the actions carry letters (`n` new tab, `r` rename
  // tab, `d` close tab); the pages, picked with the cursor, point the active
  // tab at themselves. The open tabs are not listed here — a number key
  // switches straight to one (see `TabNumbers`), and the tab bar shows the
  // order.
  const pickerItems: KeyMenuItem[] = [
    {
      key: "n",
      label: "New tab",
      run: newTab,
    },
    {
      key: "r",
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
      label: page.label,
      detail: "Open in this tab",
      run: () => openPage(page),
    })),
  ];

  return (
    <KeymapProvider>
      <SettingsProvider>
        <NormalMode
          onOpenTabs={() => setPickerOpen(true)}
          onSwitch={switchTab}
        />
        {/* Empty until a page portals into it, so pages without a bar lose no
            vertical space. */}
        <div ref={setSlot} className="shrink-0 empty:hidden" />
        <headerSlot.Provider value={slot}>
          <main className="min-h-0 flex-1 overflow-y-auto scrollbar-none">
            {children}
          </main>
        </headerSlot.Provider>
        <TabBar tabs={tabs} activeId={activeId} onActivate={activate} />
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