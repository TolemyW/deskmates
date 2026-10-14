// Entry point of the standalone demo: the real UI on top of an in-browser mock Gateway with a
// scripted three-bot team. Nothing here reaches a network; reloading the page resets the demo.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { installMockGateway } from "./demo/install.js";
import "./styles/index.js";

// The mock answers `/auth/session` with a signed-in demo person, so the demo opens on the chats.
installMockGateway();
if (!window.location.hash) window.location.hash = "#/threads";

const root = document.getElementById("root");
if (!root) throw new Error("demo.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
