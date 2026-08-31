import { useState } from "react";
import { matrixService, trip, tripStore } from "../store/index.js";
import { runArrange } from "../store/arrange.js";
import { renderTrip } from "../store/handback.js";

export function ArrangeButton() {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        disabled={busy}
        title="Recluster and reorder the whole trip by travel time"
        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-slate-400 disabled:opacity-50"
        onClick={() => {
          setBusy(true);
          setStatus("arranging…");
          void runArrange(trip, matrixService, "human").then((r) => {
            setBusy(false);
            setStatus("error" in r ? r.error : null);
          });
        }}
      >
        Arrange days
      </button>
      {status && <span className="max-w-[14rem] truncate text-[11px] text-slate-500">{status}</span>}
    </span>
  );
}

export function CopyButton() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy the whole itinerary as readable text"
      className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-slate-400"
      onClick={() => {
        const text = renderTrip(tripStore.getState());
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied ✓" : "Copy itinerary"}
    </button>
  );
}
