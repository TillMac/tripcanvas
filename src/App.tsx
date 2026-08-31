import { useEffect, useState } from "react";
import { DndContext, pointerWithin } from "@dnd-kit/core";
import { actions, tripStore } from "./store/index.js";
import { tripWarnings } from "./store/schedule.js";
import { computeDaySchedule } from "./store/schedule.js";
import { CandidateDrawer } from "./ui/CandidateDrawer.js";
import { DayTabs } from "./ui/DayTabs.js";
import { MapPane, type MapLeg, type MapMarker } from "./ui/MapPane.js";
import { SearchBox } from "./ui/SearchBox.js";
import { Timeline } from "./ui/Timeline.js";
import { LodgingControl } from "./ui/LodgingControl.js";
import { ArrangeButton, CopyButton } from "./ui/HeaderButtons.js";
import { PendingBar } from "./ui/PendingBar.js";
import { useTrip } from "./ui/useTrip.js";

function useUndoKey() {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        actions.undo();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
}

function NewTripButton() {
  const [arming, setArming] = useState(false);
  if (!arming) {
    return (
      <button
        type="button"
        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-slate-400"
        onClick={() => setArming(true)}
      >
        New trip
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs">
      <span className="text-red-600">Clear the whole trip?</span>
      <button
        type="button"
        className="rounded bg-red-600 px-2 py-1 text-white"
        onClick={() => {
          actions.newTrip();
          setArming(false);
        }}
      >
        Yes, clear
      </button>
      <button type="button" className="rounded border border-slate-300 px-2 py-1" onClick={() => setArming(false)}>
        Keep
      </button>
    </span>
  );
}

export default function App({ agentAvailable }: { agentAvailable: boolean }) {
  const state = useTrip((s) => s);
  const [activeDay, setActiveDay] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useUndoKey();

  const dayCount = state.days.length;
  const day = Math.min(Math.max(1, activeDay), Math.max(1, dayCount));
  const empty = dayCount === 0 && state.candidates.length === 0;
  const warnings = tripWarnings(state);

  // Map content: the active day's sequence + candidates + resolving pins.
  const markers: MapMarker[] = [];
  const legs: MapLeg[] = [];
  if (dayCount > 0) {
    const sched = computeDaySchedule(state, day);
    const startAnchor = state.nights[day - 1];
    if (startAnchor && state.places[startAnchor]) {
      const p = state.places[startAnchor];
      markers.push({ id: `lodging`, name: p.name, lat: p.lat, lng: p.lon, kind: "lodging" });
    }
    state.days[day - 1].stops.forEach((sid, i) => {
      const p = state.places[state.stops[sid].place];
      markers.push({
        id: sid, name: p.name, lat: p.lat, lng: p.lon, kind: "stop", order: i + 1,
        pending: !!state.stops[sid].pending, selected: selectedId === sid,
      });
    });
    for (const st of sched.stops) {
      if (st.legIn) {
        const a = state.places[st.legIn.fromPid];
        const b = state.places[st.legIn.toPid];
        legs.push({
          from: [a.lat, a.lon], to: [b.lat, b.lon], mode: st.legIn.mode,
          path: st.legIn.transit?.steps.map((x) => ({ mode: x.mode, coords: x.coords })),
        });
      }
    }
    if (sched.backLeg) {
      const a = state.places[sched.backLeg.fromPid];
      const b = state.places[sched.backLeg.toPid];
      legs.push({
        from: [a.lat, a.lon], to: [b.lat, b.lon], mode: sched.backLeg.mode,
        path: sched.backLeg.transit?.steps.map((x) => ({ mode: x.mode, coords: x.coords })),
      });
    }
  }
  for (const sid of state.candidates) {
    const p = state.places[state.stops[sid].place];
    markers.push({ id: sid, name: p.name, lat: p.lat, lng: p.lon, kind: "candidate", selected: selectedId === sid });
  }
  state.resolvingPins.forEach((pin, i) =>
    markers.push({ id: `resolving-${i}`, name: pin.name, lat: pin.lat, lng: pin.lon, kind: "resolving" }),
  );

  return (
    <div className="flex h-screen flex-col bg-white text-slate-900">
      {!agentAvailable && (
        <div className="bg-amber-100 px-4 py-1.5 text-xs text-amber-900">
          Your browser has no WebMCP agent — tripcanvas works as a manual planner. In Chrome 149+, enable
          chrome://flags/#enable-webmcp-testing to let a browser agent co-edit this trip.
        </div>
      )}
      <header className="flex items-center gap-3 border-b border-slate-200 px-3 py-2">
        <h1 className="text-lg font-semibold">tripcanvas</h1>
        <SearchBox activeDay={day} />
        <LodgingControl />
        <button
          type="button"
          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-slate-400"
          onClick={() => actions.undo()}
          title="Undo (Ctrl+Z) — one history for you and the agent"
        >
          ↶ Undo
        </button>
        <ArrangeButton />
        <CopyButton />
        <NewTripButton />
      </header>

      <PendingBar />

      {(warnings.overflowDays.length > 0 || warnings.longLegCount > 0 || warnings.approx) && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-800">
          {warnings.overflowDays.length > 0 && <span className="mr-3">⚠ Day {warnings.overflowDays.join(", ")} ends past 22:00</span>}
          {warnings.longLegCount > 0 && <span className="mr-3">⚠ {warnings.longLegCount} leg{warnings.longLegCount > 1 ? "s" : ""} over 40 min</span>}
          {warnings.approx && <span>≈ some times approximate — routing service unavailable or refreshing</span>}
        </div>
      )}

      <DndContext
        collisionDetection={pointerWithin}
        onDragEnd={(e) => {
          const a = String(e.active.id);
          if (a.startsWith("cand:") && e.over) {
            const sid = a.slice(5);
            const overId = String(e.over.id);
            if (overId.startsWith("day-")) {
              const d = parseInt(overId.slice(4), 10);
              if (!isNaN(d)) actions.moveStop("human", sid, d);
            }
          }
        }}
      >
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <MapPane markers={markers} legs={legs} onSelect={(id) => setSelectedId(id)} />
          </div>
          <div className="flex w-[430px] shrink-0 flex-col border-l border-slate-200">
            <DayTabs
              dayCount={dayCount}
              active={day}
              onSelect={(d) => setActiveDay(d)}
              onAddDay={() => actions.ensureDays("human", dayCount + 1)}
            />
            {empty ? (
              <div className="flex flex-1 items-center justify-center p-6">
                <p className="rounded border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
                  Try: ask your agent to plan 3 days in Tokyo.
                  <br />
                  <span className="text-xs">…or search a place above and press Enter.</span>
                </p>
              </div>
            ) : (
              <Timeline day={day} selectedId={selectedId} onSelect={setSelectedId} />
            )}
            <CandidateDrawer activeDay={day} />
          </div>
        </div>
      </DndContext>
    </div>
  );
}

export function __getStoreForDevtools() {
  return tripStore.getState();
}
