// Enter-only place search (Nominatim policy: no autocomplete — ban offence)
// through the ONE app-wide queue the tools share.
import { useState } from "react";
import { actions, nominatim, tripStore } from "../store/index.js";
import { toPlaceInput } from "../store/nominatim.js";
import { useTrip } from "./useTrip.js";

export function SearchBox({ activeDay }: { activeDay: number }) {
  const dayCount = useTrip((s) => s.days.length);
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<string>("active");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    const query = q.trim();
    if (!query || busy) return;
    setBusy(true);
    setStatus("resolving…");
    try {
      const r = await nominatim.resolve(query);
      if (!r.ok) {
        setStatus(r.message);
        return;
      }
      const input = toPlaceInput(r.place, query);
      if (target === "candidates") {
        const res = actions.addResolvedStop("human", input, {});
        setStatus(`added [${res.sid}] ${r.place.name} to candidates`);
      } else {
        let day = target === "active" ? Math.max(1, activeDay) : parseInt(target, 10);
        if (tripStore.getState().days.length === 0) {
          actions.ensureDays("human", 1);
          day = 1;
        }
        const res = actions.addResolvedStop("human", input, { day });
        setStatus(`added [${res.sid}] ${r.place.name} to Day ${res.day}`);
      }
      setQ("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 items-center gap-2">
      <input
        type="search"
        aria-label="search a place"
        placeholder="Add a place — press Enter"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void search();
        }}
        className="h-8 w-full max-w-md rounded-full border border-transparent bg-slate-100 px-3.5 text-sm placeholder:text-slate-400 focus:border-teal-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600/20"
        disabled={busy}
      />
      <select
        aria-label="where the result lands"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="cursor-pointer appearance-none rounded-md border-0 bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-600/30"
      >
        <option value="active">→ current day</option>
        {Array.from({ length: dayCount }, (_, i) => i + 1).map((d) => (
          <option key={d} value={d}>→ Day {d}</option>
        ))}
        <option value="candidates">→ Candidates</option>
      </select>
      {status && <span className="max-w-xs truncate text-xs text-slate-500">{status}</span>}
    </div>
  );
}
