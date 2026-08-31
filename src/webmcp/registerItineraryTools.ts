// The one seam between the page and WebMCP (docs/design/tool-layer.md §5).
// Called ONCE at module scope in main.tsx before createRoot — StrictMode
// double-mount cannot re-run module scope; the module-level flag guards HMR
// (register-once, no AbortSignal reliance). Tools are never unregistered.
import { webmcpAvailable } from "./modelContext.js";
import { buildTools, type ToolDeps } from "./tools.js";

let registered = false;

/** True when WebMCP is present and the tools were registered. */
export function registerItineraryTools(deps: ToolDeps): boolean {
  if (!webmcpAvailable()) return false;
  if (registered) return true;
  registered = true;
  for (const tool of buildTools(deps)) {
    void document.modelContext!.registerTool(tool);
  }
  return true;
}
