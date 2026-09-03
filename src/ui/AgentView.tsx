// The agent's exact view of the trip (get_itinerary text), live. Read-only:
// rendering it never advances the agent's read cursor.
import { renderAgentView } from "../store/handback.js";
import { useTrip } from "./useTrip.js";

export function AgentView() {
  const text = useTrip(renderAgentView);
  return (
    <details className="border-t border-slate-200 px-4 py-2">
      <summary className="cursor-pointer select-none text-[11px] text-slate-500 hover:text-slate-800">
        What the agent sees (get_itinerary)
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-[11px] leading-snug text-slate-700">
        {text}
      </pre>
    </details>
  );
}
