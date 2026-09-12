import { AppShell } from "@/components/app-shell";
import { SettingsProvider } from "@/lib/settings";
import { PluginsProvider } from "@/lib/plugins";
import { ChatProvider } from "@/lib/chat-store";

// There is no single URL to route anymore: each tab owns a tree of panes,
// and each pane mounts the app's pages in its own in-memory router (see
// `lib/routes.ts` and `components/app-shell.tsx`), so a pane keeps its
// session and history even while hidden behind a tab switch.
//
// Everything a pane would otherwise load for itself — settings, the plugin
// list, the chat sessions list and per-session seed graphs — is loaded once
// here, at app start, and shared by every pane through these providers.
export default function App() {
  return (
    <SettingsProvider>
      <PluginsProvider>
        <ChatProvider>
          <AppShell />
        </ChatProvider>
      </PluginsProvider>
    </SettingsProvider>
  );
}
