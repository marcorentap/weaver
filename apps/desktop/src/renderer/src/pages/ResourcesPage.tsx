import { useRef } from "react";
import { useKeyLayer } from "@/lib/keymap";
import { useViewportBindings } from "@/lib/viewport";

export default function ResourcesPage() {
  /** Anchors the shared page-scroll keys (`ctrl+d` / `ctrl+u` / `G` / `gg`)
   *  to the scrolling box this page lives in, the shell's `<main>`. */
  const root = useRef<HTMLDivElement>(null);
  const viewport = useViewportBindings(root);
  useKeyLayer({
    id: "resources-scroll",
    bindings: viewport,
  });

  return (
    <div ref={root} className="flex min-h-full flex-col">
      <header className="border-b px-3 py-1">
        <span className="font-semibold">Resources</span>
      </header>

      <p className="p-3 text-muted-foreground">Nothing here yet.</p>
    </div>
  );
}
