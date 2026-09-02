// ADR-0004 review UX — the product's hero feature: every agent edit is
// applied-but-pending; this bar gives the human per-edit Revert and one-click
// Accept all. Copy here is presentation-layer only: the store's summaries stay
// in the compact agent vocabulary (D2 pos4) that get_changes/handback print.
import { actions } from "../store/index.js";
import { pendingEdits } from "../store/store.js";
import { useTrip } from "./useTrip.js";

/** "added [s8] Shinjuku Gyoen to D2 pos4" -> "added Shinjuku Gyoen to Day 2, stop 4" */
export function humanizeSummary(summary: string): string {
  return summary
    .replace(/\[[sc]\d+\]\s*/g, "")
    .replace(/\bD(\d+) pos(\d+)/g, "Day $1, stop $2")
    .replace(/\bD(\d+)\b/g, "Day $1")
    .replace(/\bpos(\d+)\b/g, "stop $1");
}

export function PendingBar() {
  const state = useTrip((s) => s);
  const pend = pendingEdits(state);
  if (pend.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 animate-[tc-slide_.25s_ease-out]">
      <span className="text-xs font-semibold text-amber-900">
        ✦ Agent changed {pend.length} thing{pend.length > 1 ? "s" : ""}:
      </span>
      {pend.map((p) => (
        <span
          key={p.editId}
          className="flex items-center gap-1.5 rounded-full border border-amber-300 bg-white px-2.5 py-1 text-xs shadow-sm"
          title={`${p.editId} · ${p.entry.summary}`}
        >
          <span className="font-mono text-[10px] text-slate-400">{p.editId}</span>
          <span className="max-w-[18rem] truncate">{humanizeSummary(p.entry.summary)}</span>
          <button
            type="button"
            aria-label={`revert ${p.editId}`}
            className="rounded border border-amber-400 px-1.5 font-semibold text-amber-800 hover:bg-amber-200"
            onClick={() => actions.revert("human", p.editId)}
          >
            ↩ Revert
          </button>
        </span>
      ))}
      {pend.some((p) => p.entry.op === "plan") && (
        <span className="basis-full text-[10px] text-amber-800">
          Places picked by your agent · routes &amp; times from OpenStreetMap services
        </span>
      )}
      <button
        type="button"
        className="ml-auto rounded-full bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-amber-700"
        onClick={() => actions.acceptAll()}
      >
        Accept all
      </button>
    </div>
  );
}
