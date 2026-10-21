import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

/**
 * A file dropped anywhere the app does not handle is swallowed here. Chromium's
 * default for a dropped file is to navigate the window to it, which would
 * replace the running session with a `file://` page and lose everything on
 * screen. The chat page is the one surface that takes files on purpose, and it
 * handles its own drop first — these listeners only see what it left alone,
 * since they run after its handler and a dropped file there is prevented
 * already. Text drags still behave natively; only drags carrying files are
 * intercepted, which is what `types` distinguishes.
 */
const carriesFiles = (event: DragEvent): boolean =>
  event.dataTransfer?.types.includes("Files") ?? false;

window.addEventListener("dragover", (event) => {
  if (carriesFiles(event)) event.preventDefault();
});

window.addEventListener("drop", (event) => {
  if (carriesFiles(event)) event.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
