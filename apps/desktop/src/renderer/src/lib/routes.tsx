import { Navigate, type RouteObject } from "react-router-dom";
import ChatPage from "@/pages/ChatPage";
import SettingsPage from "@/pages/SettingsPage";
import ResourcesPage from "@/pages/ResourcesPage";

/**
 * The app's pages, as router routes. Each pane mounts this list in its own
 * in-memory router (see `app-shell.tsx`), so every pane has its own location
 * and history; there is no single global URL anymore.
 */
export const APP_ROUTES: RouteObject[] = [
  { path: "/", element: <Navigate to="/chat" replace /> },
  { path: "/chat", element: <ChatPage /> },
  { path: "/settings", element: <SettingsPage /> },
  { path: "/resources", element: <ResourcesPage /> },
];