import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PetApp } from "./PetApp.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PetApp />
  </StrictMode>,
);
