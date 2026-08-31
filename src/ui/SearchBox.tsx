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
        placeholder="Add a place — type a name, press Enter (e.g. 'Ghibli Museum, Mitaka')"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void search();
        }}
        className="w-full max-w-md rounded border border-slate-300 bg-white px-2 py-1 text-sm"
        disabled={busy}
      />
      <select
        aria-label="where the result lands"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="rounded border border-slate-300 bg-white px-1 py-1 text-xs text-slate-700"
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
