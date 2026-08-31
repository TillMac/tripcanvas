import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { registerItineraryTools } from "./webmcp/registerItineraryTools.js";
import "./index.css";

// Register ONCE at module scope, before createRoot (ADR in tool-layer.md §5).
const agentAvailable = registerItineraryTools();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App agentAvailable={agentAvailable} />
  </StrictMode>,
);
