import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PetLab } from "./PetLab.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PetLab />
  </StrictMode>,
);
