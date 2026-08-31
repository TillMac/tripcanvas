// Single trip-lodging input: anchors all nights (per-night override in T5 UI).
import { useState } from "react";
import { actions, nominatim, tripStore } from "../store/index.js";
import { useTrip } from "./useTrip.js";

export function LodgingControl() {
  const nights = useTrip((s) => s.nights);
  const places = useTrip((s) => s.places);
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const current = nights.find((n) => n) ? places[nights.find((n) => n)!]?.name : null;

  async function submit() {
    const query = q.trim();
    if (!query) return;
    setStatus("resolving…");
    const r = await nominatim.resolve(query);
    if (!r.ok) {
      setStatus(r.message);
      return;
    }
    if (tripStore.getState().days.length === 0) actions.ensureDays("human", 1);
    const res = actions.setLodging("human", { name: r.place.name, lat: r.place.lat!, lon: r.place.lng!, query });
    setStatus("error" in res ? res.error : null);
    if (!("error" in res)) {
      setEditing(false);
      setQ("");
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-slate-400"
        onClick={() => setEditing(true)}
        title="Lodging anchors where each day starts and ends"
      >
        {"\u{1F3E8}"} {current ?? "Set lodging"}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <input
        autoFocus
        type="text"
        aria-label="lodging name"
        placeholder="Hotel name + city, press Enter"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-56 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
      />
      {status && <span className="max-w-[16rem] truncate text-[11px] text-slate-500">{status}</span>}
    </span>
  );
}
