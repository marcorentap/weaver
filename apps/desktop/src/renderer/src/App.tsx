import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/app-shell";
import ChatPage from "@/pages/ChatPage";
import SettingsPage from "@/pages/SettingsPage";
import ResourcesPage from "@/pages/ResourcesPage";

// No server, so path-based routing needs no server-side rewrite support —
// `HashRouter` works from a `file://`-loaded `index.html` in a packaged
// Electron app, unlike `BrowserRouter`, which needs a server (or dev
// middleware) to answer every path with the same document.
export default function App() {
  return (
    <HashRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/resources" element={<ResourcesPage />} />
        </Routes>
      </AppShell>
    </HashRouter>
  );
}
