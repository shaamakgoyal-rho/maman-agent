import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { bootAgentService } from "../lib/agentService.js";
import "../styles.css";

// The agent service boots HERE, at the entry, not inside a component: an
// agent's triggers must outlive every screen, and a service started from a
// useEffect dies with its component. Errors surface in the console rather than
// silently disabling proactivity — the service itself reports specifics.
void bootAgentService();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
