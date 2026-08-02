import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StatusBar } from "./StatusBar.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StatusBar />
  </StrictMode>,
);
