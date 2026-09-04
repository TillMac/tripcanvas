// Two live text views under the schedule. Read-only: rendering never advances
// the agent's read cursor. HumanView is exactly what Copy itinerary puts on the
// clipboard; AgentView is the agent's get_itinerary text.
import { renderAgentView, renderHumanTrip } from "../store/handback.js";
import { useTrip } from "./useTrip.js";

function TextPanel({ title, text }: { title: string; text: string }) {
  return (
    <details className="border-t border-slate-200 px-4 py-2">
      <summary className="cursor-pointer select-none text-[11px] text-slate-500 hover:text-slate-800">{title}</summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-[11px] leading-snug text-slate-700">
        {text}
      </pre>
    </details>
  );
}

export function HumanView() {
  const text = useTrip(renderHumanTrip);
  return <TextPanel title="Itinerary as text (what Copy gives you)" text={text} />;
}

export function AgentView() {
  const text = useTrip(renderAgentView);
  return <TextPanel title="What the agent sees (get_itinerary)" text={text} />;
}
