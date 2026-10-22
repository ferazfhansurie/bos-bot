// The notch window's page (electron/notch.mjs loads /notch.html). Its own
// small bundle: no app shell, no store, no network.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NotchApp } from "./NotchApp";
import "./notch.css";

createRoot(document.getElementById("notch")!).render(
  <StrictMode>
    <NotchApp />
  </StrictMode>,
);
