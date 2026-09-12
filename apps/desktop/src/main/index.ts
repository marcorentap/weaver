import { join } from "node:path";
import { app, BrowserWindow, protocol, shell } from "electron";
import { registerMediaProtocol, MEDIA_PROTOCOL_PRIVILEGES } from "./ipc/media-protocol.js";
import { registerChatHandlers } from "./ipc/chat.js";
import { registerAgentHandlers } from "./ipc/agent.js";
import { registerSettingsHandlers } from "./ipc/settings.js";
import { registerPluginHandlers } from "./ipc/plugins.js";
import { registerRemoteHandlers, startServerFromStoredSettings } from "./ipc/remote.js";
import { ensurePluginsLoaded } from "./lib/plugins.js";

// setName() only sets the display name now. WM_CLASS/app_id comes from
// setDesktopName(), which must match the installed .desktop filename
// ("weaver.desktop", see electron-builder.yml) or taskbar grouping breaks.
app.setName("Weaver");
app.setDesktopName("weaver.desktop");

// Must run before `app.whenReady()`. Electron only honors privilege
// registration for schemes declared at module load time.
protocol.registerSchemesAsPrivileged([MEDIA_PROTOCOL_PRIVILEGES]);

const isDev = !app.isPackaged;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  win.on("ready-to-show", () => win.show());

  // Every graph, media file and shell/read/write/edit tool call already
  // stays inside the operator's own project and store — the same trust
  // boundary a browser tab never had, so external links are the only thing
  // still worth stopping from hijacking the window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Ctrl+W is the default "Close" menu accelerator and would silently kill
  // the whole app mid-session, so swallow it before it reaches the menu.
  // (before-input-event.preventDefault stops both the page event and the
  // menu shortcuts.) The window still closes via the OS title bar / Alt+F4.
  win.webContents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown" &&
      input.control &&
      !input.alt &&
      !input.shift &&
      !input.meta &&
      input.key.toLowerCase() === "w"
    ) {
      event.preventDefault();
    }
  });

  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }

  return win;
}

void app.whenReady().then(async () => {
  registerMediaProtocol();
  // Load plugins before any window opens so the store validates block
  // writes against the full kind registry and the first run mounts the
  // loaded plugin tools from the start.
  await ensurePluginsLoaded();
  registerChatHandlers();
  registerAgentHandlers();
  registerSettingsHandlers();
  registerPluginHandlers();
  registerRemoteHandlers();
  // If the operator left this machine's server on, bring it back up before
  // the window opens so a remote peer is never left hanging on a restart.
  startServerFromStoredSettings();

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
