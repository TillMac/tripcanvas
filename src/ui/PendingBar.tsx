// ADR-0004 review UX: every agent edit is applied-but-pending; this bar gives
// the human per-edit Revert and one-click Accept all.
import { actions } from "../store/index.js";
import { pendingEdits } from "../store/store.js";
import { useTrip } from "./useTrip.js";

export function PendingBar() {
  const state = useTrip((s) => s);
  const pend = pendingEdits(state);
  if (pend.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-amber-300 bg-amber-100 px-3 py-1.5 text-xs text-amber-900">
      <span className="font-semibold">Agent changed {pend.length} thing{pend.length > 1 ? "s" : ""}:</span>
      {pend.map((p) => (
        <span key={p.editId} className="flex items-center gap-1 rounded-full border border-amber-300 bg-white px-2 py-0.5">
          <span className="max-w-[16rem] truncate" title={p.entry.summary}>
            {p.editId}: {p.entry.summary}
          </span>
          <button
            type="button"
            aria-label={`revert ${p.editId}`}
            className="rounded px-1 text-amber-700 hover:bg-amber-200"
            onClick={() => actions.revert("human", p.editId)}
          >
            Revert
          </button>
        </span>
      ))}
      {pend.some((p) => p.entry.op === "plan") && (
        <span className="basis-full text-[11px] text-amber-700">
          Provenance: places chosen by your agent; travel times and geocoding from OpenStreetMap routing services.
        </span>
      )}
      <button
        type="button"
        className="ml-auto rounded bg-amber-600 px-2 py-1 font-semibold text-white hover:bg-amber-700"
        onClick={() => actions.acceptAll()}
      >
        Accept all
      </button>
    </div>
  );
}
