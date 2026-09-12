import { AppShell } from "@/components/app-shell";

// There is no single URL to route anymore: each tab owns a tree of panes,
// and each pane mounts the app's pages in its own in-memory router (see
// `lib/routes.ts` and `components/app-shell.tsx`), so a pane keeps its
// session and history even while hidden behind a tab switch.
export default function App() {
  return <AppShell />;
}