import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { bootAgentService } from "../lib/agentService.js";
import { bootMotherLoop } from "../lib/motherLoop.js";
import "../styles.css";

// Both services boot HERE, at the entry, not inside a component: an agent's
// triggers and Maman's noticing must outlive every screen, and a service
// started from a useEffect dies with its component. Errors surface as
// structured diagnostics rather than silently disabling proactivity.
void bootAgentService();
bootMotherLoop();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
