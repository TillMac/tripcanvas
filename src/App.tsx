import { useEffect, useState } from "react";
import { DndContext, pointerWithin } from "@dnd-kit/core";
import { actions, trip } from "./store/index.js";
import { loadSampleTrip } from "./store/sampleTrip.js";
import { tripWarnings } from "./store/schedule.js";
import { computeDaySchedule } from "./store/schedule.js";
import { AgentView, HumanView } from "./ui/AgentView.js";
import { CandidateDrawer } from "./ui/CandidateDrawer.js";
import { DayTabs } from "./ui/DayTabs.js";
import { MapPane, type MapLeg, type MapMarker } from "./ui/MapPane.js";
import { SearchBox } from "./ui/SearchBox.js";
import { SchedulePanel } from "./ui/SchedulePanel.js";
import { LodgingControl } from "./ui/LodgingControl.js";
import { ArrangeButton, CopyButton } from "./ui/HeaderButtons.js";
import { PendingBar } from "./ui/PendingBar.js";
import { useTrip } from "./ui/useTrip.js";

const SAMPLE_PROMPT = "Plan 3 days in Tokyo: temples, museums, Shibuya and teamLab — stay near Shinjuku.";

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
        className="rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
        onClick={() => setArming(true)}
      >
        New trip
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs">
      <span className="font-medium text-red-600">Clear the whole trip?</span>
      <button
        type="button"
        className="rounded-md bg-red-600 px-2 py-1 font-medium text-white"
        onClick={() => {
          actions.newTrip();
          setArming(false);
        }}
      >
        Yes, clear
      </button>
      <button type="button" className="rounded-md border border-slate-300 px-2 py-1" onClick={() => setArming(false)}>
        Keep
      </button>
    </span>
  );
}

function EmptyState({ agentAvailable }: { agentAvailable: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-3xl">{"\u{1F5FA}\u{FE0F}"}</div>
      <p className="text-base font-semibold text-slate-800">Plan a trip with your browser agent</p>
      <p className="max-w-[260px] text-xs leading-relaxed text-slate-500">
        The agent edits this itinerary through 11 WebMCP tools — every change lands here, marked for
        your review. Or search a place above and press Enter.
      </p>
      {agentAvailable && (
        <button
          type="button"
          title="Copy this prompt for your agent"
          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600 hover:border-teal-600 hover:text-slate-800"
          onClick={() => {
            void navigator.clipboard?.writeText(SAMPLE_PROMPT).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied ✓ — now ask your agent" : `“${SAMPLE_PROMPT}” ⧉`}
        </button>
      )}
      <button
        type="button"
        className="rounded-full bg-teal-700 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-teal-800"
        onClick={() => loadSampleTrip(trip, { exampleEdit: !agentAvailable })}
      >
        Load a sample 3-day Tokyo trip
      </button>
      <p className="text-[10px] text-slate-400">One click, no account — undo anytime.</p>
    </div>
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
          tripcanvas is built for browser agents (WebMCP) — none detected, so you're in manual mode.
          Try the sample trip, or enable chrome://flags/#enable-webmcp-testing in Chrome 149+.
        </div>
      )}
      <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-2.5">
        <h1 className="text-[17px] font-bold tracking-tight">
          trip<span className="text-teal-700">canvas</span>
        </h1>
        {agentAvailable && (
          <span className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            ● WebMCP ready · 12 tools
          </span>
        )}
        <SearchBox activeDay={day} />
        <LodgingControl />
        <button
          type="button"
          className="rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
          onClick={() => actions.undo()}
          title="Undo (Ctrl+Z) — one shared history for you and the agent"
        >
          ↶ Undo
        </button>
        <ArrangeButton />
        <CopyButton />
        <NewTripButton />
      </header>

      <PendingBar />

      {(warnings.overflowDays.length > 0 || warnings.longLegCount > 0 || warnings.approx) && (
        <div className="border-b border-slate-200 bg-white px-4 py-1.5 text-[11px] text-slate-600">
          {warnings.overflowDays.length > 0 && (
            <span className="mr-3"><span className="text-amber-600">⚠</span> Day {warnings.overflowDays.join(", ")} ends past 22:00</span>
          )}
          {warnings.longLegCount > 0 && (
            <span className="mr-3"><span className="text-amber-600">⚠</span> {warnings.longLegCount} leg{warnings.longLegCount > 1 ? "s" : ""} over 40 min</span>
          )}
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
              <EmptyState agentAvailable={agentAvailable} />
            ) : (
              <SchedulePanel day={day} selectedId={selectedId} onSelect={setSelectedId} />
            )}
            {!empty && <CandidateDrawer activeDay={day} />}
            {!empty && <HumanView />}
            {!empty && <AgentView />}
          </div>
        </div>
      </DndContext>
    </div>
  );
}
