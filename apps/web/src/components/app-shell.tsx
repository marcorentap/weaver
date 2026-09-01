"use client";

import { createContext, useContext, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { SettingsProvider } from "@/lib/settings";
import {
  HELP_KEY,
  KeymapProvider,
  useKeyLayer,
  useToggleHelp,
} from "@/lib/keymap";
import { cn } from "@/lib/utils";

/**
 * The shell's own header region. A page fills it through `ShellHeader`, so its
 * bar is a sibling of the tab bar rather than the first row of the scrolling
 * content: both stay put, and only what is between them moves.
 */
const headerSlot = createContext<HTMLElement | null>(null);

export function ShellHeader({ children }: { children: React.ReactNode }) {
  const node = useContext(headerSlot);
  return node ? createPortal(children, node) : null;
}

/** Bottom tab bar, addressed by `Tab` + number from any mode. */
const TABS = [
  { key: "1", label: "chat", href: "/chat" },
  { key: "2", label: "resources", href: "/resources" },
  { key: "3", label: "settings", href: "/settings" },
] as const;

/**
 * Normal mode: the bottom of the keymap stack, live everywhere. Page layers
 * stack on top of it, so tab switching keeps working inside a page's mode and
 * stops only inside a modal popup.
 */
function NormalMode() {
  const router = useRouter();
  const pathname = usePathname();

  const switchTab = (delta: number) => {
    const current = Math.max(
      TABS.findIndex((tab) => tab.href === pathname),
      0,
    );
    const next = TABS[(current + delta + TABS.length) % TABS.length];
    if (next) router.push(next.href);
  };

  useKeyLayer({
    id: "normal",
    bindings: [
      ...TABS.map((tab) => ({
        chord: ["Tab", tab.key] as const,
        help: { keys: `tab ${tab.key}`, label: `go to ${tab.label}` },
        run: () => router.push(tab.href),
      })),
      {
        keys: ["["],
        help: { keys: "[", label: "previous tab" },
        run: () => switchTab(-1),
      },
      {
        keys: ["]"],
        help: { keys: "]", label: "next tab" },
        run: () => switchTab(1),
      },
    ],
  });

  return null;
}

function TabBar() {
  const pathname = usePathname();
  const toggleHelp = useToggleHelp();

  return (
    <nav className="flex items-center gap-1 border-t px-2 py-1">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "px-2 py-0.5",
              active
                ? "font-medium text-white"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            [{tab.key} {tab.label}]
          </Link>
        );
      })}
      {/* The one key that has to be discoverable without opening help. */}
      <button
        type="button"
        onClick={toggleHelp}
        className="ml-auto px-2 py-0.5 text-muted-foreground hover:text-foreground"
      >
        {HELP_KEY} help
      </button>
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  return (
    <KeymapProvider>
      <SettingsProvider>
        <NormalMode />
        {/* Empty until a page portals into it, so pages without a bar lose no
            vertical space. */}
        <div ref={setSlot} className="shrink-0 empty:hidden" />
        <headerSlot.Provider value={slot}>
          <main className="min-h-0 flex-1 overflow-y-auto scrollbar-none">
            {children}
          </main>
        </headerSlot.Provider>
        <TabBar />
      </SettingsProvider>
    </KeymapProvider>
  );
}
