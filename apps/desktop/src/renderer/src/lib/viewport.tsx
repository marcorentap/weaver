import type { RefObject } from "react";
import type { KeyBinding } from "@/lib/keymap";

/**
 * The familiar vim page-scroll interactions, shared by every scrollable
 * page: `ctrl+d` / `ctrl+u` half a viewport, `G` to the bottom, `gg` to the
 * top. A page opts in with `useViewportBindings(root)` and its own root
 * ref, and gets the four keys for free, no per-page reimplementation.
 *
 * Chat's block cursor does not use this layer: there a "page" means the
 * block at the viewport's next edge, not a raw window scroll, so its page
 * navigation keeps its own row-aware bindings and only reuses the
 * primitives below (`findScroller`).
 */

/** The nearest element that actually scrolls — AppShell's `<main>` for
 *  every page today. `root` itself counts; ascent stops at the first
 *  overflowing ancestor, so it equally finds a page's own scroll box when
 *  one appears. `null` when nothing scrolls (short content, a page with no
 *  overflow), which makes every interaction in this module a no-op rather
 *  than a crash. */
export function findScroller(root: HTMLElement | null): HTMLElement | null {
  let element = root;
  while (element && element.scrollHeight <= element.clientHeight) {
    element = element.parentElement;
  }
  return element;
}

/** Half a viewport at a time, vim's Ctrl-D / Ctrl-U step, measured from
 *  the DOM so it is right no matter how tall the rows are. */
export function scrollHalfPage(element: HTMLElement, direction: 1 | -1) {
  element.scrollBy({ top: (direction * element.clientHeight) / 2 });
}

/** `G` to the very bottom, or `gg` back to the very top, of the scroller's
 *  whole content. */
export function scrollToExtent(element: HTMLElement, bottom: boolean) {
  element.scrollTo({ top: bottom ? element.scrollHeight : 0 });
}

/**
 * The four shared page-scroll bindings, aimed at whatever scrolling box
 * `root` sits in. The calls close over the *ref*, not a captured element,
 * so they always act on the page currently mounted even if it swaps DOM in
 * place. A hook rather than a plain function so a page's ref reaches it the
 * only way refs are meant to be shared.
 */
export function useViewportBindings(
  root: RefObject<HTMLElement | null>,
): KeyBinding[] {
  const page = (direction: 1 | -1) => {
    const scroller = findScroller(root.current);
    if (scroller) scrollHalfPage(scroller, direction);
  };
  const toExtent = (bottom: boolean) => {
    const scroller = findScroller(root.current);
    if (scroller) scrollToExtent(scroller, bottom);
  };
  return [
    {
      keys: ["ctrl+d"],
      help: { keys: "ctrl+d", label: "Half page down" },
      run: () => page(1),
    },
    {
      keys: ["ctrl+u"],
      help: { keys: "ctrl+u", label: "Half page up" },
      run: () => page(-1),
    },
    {
      keys: ["G"],
      help: { keys: "G", label: "Jump to the bottom" },
      run: () => toExtent(true),
    },
    {
      chord: ["g", "g"],
      help: { keys: "gg", label: "Jump to the top" },
      run: () => toExtent(false),
    },
  ];
}