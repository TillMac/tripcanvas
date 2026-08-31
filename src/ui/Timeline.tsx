// The active day's schedule: arrival/departure per stop, leg rows with mode
// cycling, free-time blocks, warnings. Every interaction dispatches the same
// store actions the agent's tools call (ADR-0004: one truth).
import { DndContext, closestCenter, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { actions } from "../store/index.js";
import { computeDaySchedule, type DaySchedule, type LegInfo } from "../store/schedule.js";
import { fmtHHMM } from "../ported/schedule-ops.js";
import { haversineKm } from "../ported/geo.js";
import { WALK_MAX_KM, UNREASONABLE_MIN } from "../store/schedule.js";
import type { LegMode, TripState } from "../store/types.js";
import { useTrip } from "./useTrip.js";

const DWELL_OPTIONS = [15, 30, 45, 60, 90, 120, 150, 180, 240];
const FREE_OPTIONS = [15, 30, 45, 60, 90, 120];

function defaultModeFor(s: TripState, fromPid: string, toPid: string): LegMode {
  const a = s.places[fromPid];
  const b = s.places[toPid];
  const km = haversineKm({ lat: a.lat, lng: a.lon }, { lat: b.lat, lng: b.lon });
  return km <= WALK_MAX_KM ? "walk" : "drive";
}

/** walk -> drive -> transit -> back to the distance default (override removed). */
export function cycleLegMode(s: TripState, leg: LegInfo, allowTransit: boolean): void {
  const order: LegMode[] = allowTransit ? ["walk", "drive", "transit"] : ["walk", "drive"];
  const next = order[(order.indexOf(leg.mode) + 1) % order.length];
  const key = `${leg.fromPid}>${leg.toPid}`;
  if (next === defaultModeFor(s, leg.fromPid, leg.toPid)) {
    actions.setLegOverride("human", key, null);
  } else if (next === "transit") {
    // T9 wires the MOTIS fetch; until then transit is skipped via allowTransit=false.
    actions.setLegOverride("human", key, { mode: "transit" });
  } else {
    actions.setLegOverride("human", key, { mode: next });
  }
}

function LegLine({ leg, onCycle }: { leg: LegInfo; onCycle: () => void }) {
  const icon = leg.mode === "walk" ? "\u{1F6B6}" : leg.mode === "drive" ? "\u{1F697}" : "\u{1F687}";
  return (
    <div className="flex items-center gap-2 py-1 pl-3 text-[11px] text-slate-500">
      <span className="text-slate-300">┊</span>
      <button
        type="button"
        aria-label="cycle leg mode"
        onClick={onCycle}
        className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2 py-0.5 text-slate-700 hover:border-slate-400"
      >
        {icon} {leg.approx ? "≈" : ""}{leg.minutes} min
      </button>
      {leg.transit && (
        <span className="text-slate-500">{leg.transit.transfers} transfer{leg.transit.transfers === 1 ? "" : "s"}</span>
      )}
      {leg.minutes > UNREASONABLE_MIN && (
        <span className="font-semibold text-amber-700">⚠ over 40 min</span>
      )}
    </div>
  );
}

function TransitSteps({ leg }: { leg: LegInfo }) {
  if (!leg.transit || leg.transit.steps.length === 0) return null;
  return (
    <div className="ml-8 flex flex-col gap-0.5 pb-1 text-[11px] text-slate-500">
      {leg.transit.steps.map((step, i) =>
        step.mode === "walk" ? (
          <div key={i} className="text-slate-400">{"\u{1F6B6}"} walk {step.durationMin} min → {step.toName}</div>
        ) : (
          <div key={i} className="flex items-center gap-1">
            <span style={{ background: step.color ? `#${step.color}` : "#94a3b8", color: "#fff", borderRadius: 4, padding: "0 6px" }}>
              {step.line}
            </span>
            {step.durationMin} min{step.headsign ? ` toward ${step.headsign}` : ""} → off at {step.toName}
          </div>
        ),
      )}
    </div>
  );
}

function StopRow({
  sid, name, arrive, depart, dwellMin, pending, dayCount, activeDay, selected, onSelect,
}: {
  sid: string; name: string; arrive: string; depart: string; dwellMin: number;
  pending?: string; dayCount: number; activeDay: number; selected: boolean;
  onSelect: (sid: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: sid });
  const otherDays = Array.from({ length: dayCount }, (_, i) => i + 1).filter((d) => d !== activeDay);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => onSelect(sid)}
      className={`flex items-center justify-between rounded border px-2 py-1.5 text-xs text-slate-800 ${
        pending ? "border-amber-400 bg-amber-50" : selected ? "border-orange-400 bg-slate-50" : "border-slate-200 bg-slate-50"
      }`}
    >
      <span {...attributes} {...listeners} className="flex-1 cursor-grab">
        <span className="mr-2 w-14 shrink-0 font-bold tabular-nums text-blue-600">{arrive}–{depart}</span>
        <span className="mr-1 text-slate-400">[{sid}]</span>
        {name}
        {pending && (
          <span className="ml-1 rounded bg-amber-200 px-1 py-0.5 text-[10px] font-semibold text-amber-900">
            agent · {pending}
          </span>
        )}
      </span>
      <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <select
          aria-label={`${name} dwell minutes`}
          value={DWELL_OPTIONS.includes(dwellMin) ? dwellMin : dwellMin}
          onChange={(e) => actions.setDwell("human", sid, parseInt(e.target.value, 10))}
          className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px] text-slate-700"
        >
          {!DWELL_OPTIONS.includes(dwellMin) && <option value={dwellMin}>{dwellMin} min</option>}
          {DWELL_OPTIONS.map((m) => (
            <option key={m} value={m}>{m} min</option>
          ))}
        </select>
        {otherDays.length > 0 && (
          <select
            aria-label={`move ${name} to another day`}
            value=""
            onChange={(e) => {
              const d = parseInt(e.target.value, 10);
              if (!isNaN(d)) actions.moveStop("human", sid, d);
            }}
            className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px] text-slate-600"
          >
            <option value="" disabled>move…</option>
            {otherDays.map((d) => (
              <option key={d} value={d}>Day {d}</option>
            ))}
          </select>
        )}
        <button
          type="button"
          aria-label={`send ${name} to candidates`}
          title="Send to candidates (nothing is deleted)"
          onClick={() => actions.moveStop("human", sid, 0)}
          className="rounded px-1 py-0.5 text-[10px] text-slate-400 hover:bg-red-50 hover:text-red-500"
        >
          ✕
        </button>
        <span className="text-slate-400">⠿</span>
      </span>
    </div>
  );
}

function FreeRow({ label, start, minutes, onChange, onRemove }: {
  label: string; start: string; minutes: number;
  onChange: (min: number) => void; onRemove: () => void;
}) {
  return (
    <div className="my-0.5 flex items-center gap-2 rounded border border-dashed border-yellow-400 bg-yellow-50 px-2 py-1 text-xs text-yellow-800">
      <span className="w-14 shrink-0 font-bold tabular-nums text-yellow-700">{start}</span>
      <span className="flex-1 font-medium">{label}</span>
      <select
        aria-label="free time minutes"
        value={FREE_OPTIONS.includes(minutes) ? minutes : minutes}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="rounded border border-yellow-300 bg-white px-1 py-0.5 text-[10px]"
      >
        {!FREE_OPTIONS.includes(minutes) && <option value={minutes}>{minutes} min</option>}
        {FREE_OPTIONS.map((m) => (
          <option key={m} value={m}>{m} min</option>
        ))}
      </select>
      <button type="button" aria-label="remove free time" onClick={onRemove} className="h-4 w-4 rounded-full text-yellow-600 hover:bg-yellow-200">✕</button>
    </div>
  );
}

export function Timeline({
  day,
  selectedId,
  onSelect,
  allowTransit = false,
}: {
  day: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  allowTransit?: boolean;
}) {
  const state = useTrip((s) => s);
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `day-${day}` });
  if (day < 1 || day > state.days.length) return null;
  const sched: DaySchedule = computeDaySchedule(state, day);
  const d = state.days[day - 1];
  const ids = d.stops;

  return (
    <div ref={setDropRef} className={`flex-1 overflow-y-auto p-2 ${isOver ? "bg-blue-50/50" : ""}`}>
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-slate-700">
        {"\u{1F6A9}"} start
        <input
          type="time"
          aria-label="day start time"
          value={d.start}
          onChange={(e) => e.target.value && actions.setDayStart("human", day, e.target.value)}
          className="rounded border border-slate-300 bg-white px-1 py-0.5 text-slate-900"
        />
        {state.nights[day - 1] ? (
          <span className="text-slate-400">from {state.places[state.nights[day - 1]!]?.name}</span>
        ) : (
          <span className="text-slate-400">no lodging — day starts at its first stop</span>
        )}
        {!d.freeStartMin && (
          <button
            type="button"
            aria-label="add free time at day start"
            onClick={() => actions.setDayFreeStart("human", day, 30)}
            className="rounded border border-dashed border-slate-300 px-1.5 text-[10px] text-slate-400 hover:border-yellow-400 hover:text-yellow-600"
          >
            + free time
          </button>
        )}
      </div>

      {d.freeStartMin ? (
        <FreeRow
          label="Free time"
          start={d.start}
          minutes={d.freeStartMin}
          onChange={(m) => actions.setDayFreeStart("human", day, m)}
          onRemove={() => actions.setDayFreeStart("human", day, 0)}
        />
      ) : null}

      <DndContext
        collisionDetection={closestCenter}
        onDragEnd={(e) => {
          const { active, over } = e;
          if (over && active.id !== over.id) {
            const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
            const sid = String(active.id);
            actions.moveStop("human", sid, day, next.indexOf(sid) + 1);
          }
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {sched.stops.map((st) => {
            const stop = state.stops[st.sid];
            const place = state.places[stop.place];
            return (
              <div key={st.sid}>
                {st.legIn && (
                  <>
                    <LegLine leg={st.legIn} onCycle={() => cycleLegMode(state, st.legIn!, allowTransit)} />
                    {st.legIn.mode === "transit" && <TransitSteps leg={st.legIn} />}
                  </>
                )}
                <StopRow
                  sid={st.sid}
                  name={place.name}
                  arrive={fmtHHMM(st.arriveMin)}
                  depart={fmtHHMM(st.departMin)}
                  dwellMin={stop.dwellMin}
                  pending={stop.pending}
                  dayCount={state.days.length}
                  activeDay={day}
                  selected={selectedId === st.sid}
                  onSelect={onSelect}
                />
                {st.freeAfterMin > 0 ? (
                  <FreeRow
                    label="Free time"
                    start={fmtHHMM(st.departMin)}
                    minutes={st.freeAfterMin}
                    onChange={(m) => actions.setFreeAfter("human", st.sid, m)}
                    onRemove={() => actions.setFreeAfter("human", st.sid, 0)}
                  />
                ) : (
                  <button
                    type="button"
                    aria-label={`insert free time after ${place.name}`}
                    onClick={() => actions.setFreeAfter("human", st.sid, 30)}
                    className="my-0.5 flex w-full items-center justify-center gap-1 rounded border border-dashed border-slate-200 py-0.5 text-[10px] text-slate-300 hover:border-yellow-400 hover:text-yellow-600"
                  >
                    + free time
                  </button>
                )}
              </div>
            );
          })}
        </SortableContext>
      </DndContext>

      {sched.backLeg && (
        <div className="flex items-center gap-2 py-1 pl-3 text-[11px] text-slate-500">
          <span className="text-slate-300">┊</span>
          <span>
            back to lodging {sched.backLeg.mode === "walk" ? "\u{1F6B6}" : sched.backLeg.mode === "drive" ? "\u{1F697}" : "\u{1F687}"}{" "}
            {sched.backLeg.approx ? "≈" : ""}{sched.backLeg.minutes} min
          </span>
        </div>
      )}

      <div className={`px-2 py-1 text-xs ${sched.overflow ? "font-semibold text-red-600" : "text-slate-500"}`}>
        ends {fmtHHMM(sched.endMin)}{sched.overflow ? " — past 22:00" : ""}{sched.approx ? " · ≈ times approximate" : ""}
      </div>

      {day === state.days.length && ids.length > 0 && (
        <label className="flex items-center gap-1 px-2 py-1 text-[11px] text-slate-500">
          <input
            type="checkbox"
            checked={state.endLastDayAtLodging}
            onChange={(e) => actions.setEndLastDayAtLodging("human", e.target.checked)}
          />
          last day ends at lodging
        </label>
      )}
    </div>
  );
}
