// The one seam between the page and WebMCP (docs/design/tool-layer.md §5).
// Called ONCE at module scope in main.tsx before createRoot — StrictMode
// double-mount cannot re-run module scope; the module-level flag guards HMR
// (register-once, no AbortSignal reliance). Tools are never unregistered.
import { webmcpAvailable } from "./modelContext.js";
import { PLANNING_GUIDE } from "./planningGuide.js";

let registered = false;

/** True when WebMCP is present and the tools were registered. */
export function registerItineraryTools(): boolean {
  if (!webmcpAvailable()) return false;
  if (registered) return true;
  registered = true;

  document.modelContext!.registerTool({
    name: "get_planning_guide",
    description:
      "Read once before planning or filling a trip: typical minutes to spend at different kinds of places, how many stops make a comfortable day, and when to leave free time for meals. Use it to choose dwellMinutes for add_place and set_times and to decide how much to pack into a day. Static text — the live trip comes from get_itinerary.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute: () => {
      try {
        return PLANNING_GUIDE;
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  return true;
}
