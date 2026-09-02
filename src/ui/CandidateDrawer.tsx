// Candidates: places known to the trip but on no day. Nothing is ever deleted —
// removed stops land here (CONTEXT.md).
import { useDraggable } from "@dnd-kit/core";
import { useState } from "react";
import { actions } from "../store/index.js";
import { useTrip } from "./useTrip.js";

function CandidateChip({ sid, name, dayCount, activeDay, pending }: {
  sid: string; name: string; dayCount: number; activeDay: number; pending?: string;
}) {
  const [day, setDay] = useState(activeDay);
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: `cand:${sid}` });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={`flex cursor-grab items-center gap-1.5 rounded-full border bg-white px-3 py-1.5 text-xs shadow-sm ${
        pending ? "border-amber-400 bg-amber-50" : "border-slate-300 hover:border-teal-600"
      }`}
    >
      <span className="font-mono text-[10px] text-slate-400">[{sid}]</span>
      <span className="text-slate-700">{name}</span>
      {dayCount > 0 && (
        <>
          <select
            aria-label={`day for ${name}`}
            value={day}
            onChange={(e) => setDay(Number(e.target.value))}
            onClick={(e) => e.stopPropagation()}
            className="cursor-pointer appearance-none rounded-md border-0 bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-600/30"
          >
            {Array.from({ length: dayCount }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>Day {d}</option>
            ))}
          </select>
          <button
            type="button"
            aria-label={`add ${name} to day ${day}`}
            onClick={(e) => {
              e.stopPropagation();
              actions.moveStop("human", sid, day);
            }}
            className="ml-1 rounded-full bg-teal-700 px-2 py-0.5 text-white hover:bg-teal-800"
          >
            +
          </button>
        </>
      )}
    </div>
  );
}

export function CandidateDrawer({ activeDay }: { activeDay: number }) {
  const candidates = useTrip((s) => s.candidates);
  const stops = useTrip((s) => s.stops);
  const places = useTrip((s) => s.places);
  const dayCount = useTrip((s) => s.days.length);
  return (
    <div className="w-full border-t border-slate-200 bg-white">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Candidates</span>
        <span className="text-[11px] text-slate-400">drag onto the day, or pick a day and +</span>
      </div>
      <div className="flex flex-wrap gap-2 px-3 pb-3">
        {candidates.length === 0 && <span className="text-xs text-slate-400">(none — removed stops land here)</span>}
        {candidates.map((sid) => (
          <CandidateChip
            key={sid}
            sid={sid}
            name={places[stops[sid].place]?.name ?? sid}
            dayCount={dayCount}
            activeDay={Math.max(1, activeDay)}
            pending={stops[sid].pending}
          />
        ))}
      </div>
    </div>
  );
}
