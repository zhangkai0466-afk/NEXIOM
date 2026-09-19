import React from "react";
import { createRoot } from "react-dom/client";
import { Startup, StartupPreview } from "./Startup";
import "./styles.css";
import "katex/dist/katex.min.css";
import { applyStoredTypography, applyTheme, initialTheme } from "./Appearance";
import { StartupBoundary } from "./StartupBoundary";

applyTheme(initialTheme());
applyStoredTypography();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StartupBoundary>
      {import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "startup"
        ? <StartupPreview />
        : <Startup />}
    </StartupBoundary>
  </React.StrictMode>,
);
