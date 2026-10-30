import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { marketStore } from "./state/marketStore";

// Dev-only handle for perf benchmarks (scripts/perf-bench.md); stripped from production builds.
if (import.meta.env.DEV) (window as unknown as { __marketStore: typeof marketStore }).__marketStore = marketStore;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
