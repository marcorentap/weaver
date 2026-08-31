"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { HELP_KEY, KeymapProvider, useKeyLayer } from "@/lib/keymap";
import { cn } from "@/lib/utils";

/** Bottom tab bar, addressed by number key from any mode. */
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

  useKeyLayer({
    id: "normal",
    bindings: TABS.map((tab) => ({
      keys: [tab.key],
      help: { keys: tab.key, label: `go to ${tab.label}` },
      run: () => router.push(tab.href),
    })),
  });

  return null;
}

function TabBar() {
  const pathname = usePathname();

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
              "border px-2 py-0.5",
              active
                ? "border-foreground/40 bg-muted font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            [{tab.key} {tab.label}]
          </Link>
        );
      })}
      {/* The one key that has to be discoverable without opening help. */}
      <span className="pl-2 text-muted-foreground">{HELP_KEY} help</span>
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <KeymapProvider>
      <NormalMode />
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      <TabBar />
    </KeymapProvider>
  );
}
