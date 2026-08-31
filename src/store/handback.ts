// Handback (CONTEXT.md): the plain-text rendering of the whole trip, written
// to be read by an agent. Line grammar per docs/design/tool-layer.md §4.
// T8 layers the HUMAN CHANGES / YOUR PENDING EDITS sections and pagination on
// top of this body; the human Copy button uses it directly.
import { fmtHHMM } from "../ported/schedule-ops.js";
import { computeDaySchedule, tripWarnings, type LegInfo } from "./schedule.js";
import { pendingEdits } from "./store.js";
import type { Sid, TripState } from "./types.js";

function legToken(leg: LegInfo, starred: boolean): string {
  return `|${leg.mode}${leg.approx ? "≈" : ""}${leg.minutes}${starred ? "*" : ""}|`;
}

function lodgingLabel(s: TripState): string {
  const named = s.nights.filter((n): n is string => !!n);
  if (named.length === 0) return "No lodging set.";
  const first = named[0];
  if (s.nights.every((n) => n === first)) return `Lodging all nights: ${s.places[first]?.name ?? "?"}.`;
  const parts = s.nights.map((n, i) => `n${i} ${n ? (s.places[n]?.name ?? "?") : "-"}`);
  return `Lodging: ${parts.join("; ")}.`;
}

/** Is this stop's pending edit a leg-mode change (star the leg, not the name)? */
function pendingKind(s: TripState, sid: Sid): "leg" | "stop" | null {
  const e = s.stops[sid]?.pending;
  if (!e) return null;
  const entry = s.log.find((x) => x.editId === e && x.actor === "agent");
  return entry?.op === "leg" ? "leg" : "stop";
}

export function renderDayBlock(s: TripState, day: number): string[] {
  const d = s.days[day - 1];
  const sched = computeDaySchedule(s, day);
  const lines: string[] = [];
  const from = s.nights[day - 1] ? " from lodging" : "";
  lines.push(`DAY ${day} ${d.start}${from}`);
  if (d.freeStartMin) lines.push(`free ${d.start}-${fmtHHMM(sched.startMin + d.freeStartMin)} (${d.freeStartMin}m)`);
  sched.stops.forEach((st, i) => {
    const stop = s.stops[st.sid];
    const place = s.places[stop.place];
    const pk = pendingKind(s, st.sid);
    let line = `[${st.sid}] ${place.name}${pk === "stop" ? "*" : ""} ${fmtHHMM(st.arriveMin)}-${fmtHHMM(st.departMin)} d${stop.dwellMin}`;
    if (st.legIn) line += ` ${legToken(st.legIn, pk === "leg")}`;
    const last = i === sched.stops.length - 1;
    if (last) {
      if (sched.backLeg) line += ` back ${sched.backLeg.mode}${sched.backLeg.approx ? "≈" : ""}${sched.backLeg.minutes}`;
      line += ` — ends ${fmtHHMM(sched.endMin)}`;
    }
    lines.push(line);
    if (st.freeAfterMin > 0 && !last) {
      lines.push(`free ${fmtHHMM(st.departMin)}-${fmtHHMM(st.departMin + st.freeAfterMin)} (${st.freeAfterMin}m)`);
    }
  });
  if (sched.stops.length === 0) lines.push("(no stops)");
  return lines;
}

export function renderDayOneLiner(s: TripState, day: number): string {
  const sched = computeDaySchedule(s, day);
  const names = s.days[day - 1].stops.map((sid) => s.places[s.stops[sid].place].name);
  const span = sched.stops.length
    ? `${fmtHHMM(sched.stops[0].arriveMin)}-${fmtHHMM(sched.endMin)}`
    : s.days[day - 1].start;
  return `DAY ${day} ${span} ${names.length} stop${names.length === 1 ? "" : "s"}: ${names.join(" -> ") || "(none)"}`;
}

export function renderWarnings(s: TripState): string {
  const w = tripWarnings(s);
  const parts: string[] = [];
  if (w.overflowDays.length) parts.push(`day ${w.overflowDays.join(", ")} past 22:00`);
  if (w.longLegCount) parts.push(`${w.longLegCount} leg${w.longLegCount > 1 ? "s" : ""} over 40 min`);
  if (w.approx) parts.push("times approximate — routing service unavailable or refreshing");
  return parts.length
    ? `Warnings: ${parts.join("; ")}`
    : "Warnings: none (no day past 22:00, no leg over 40 min)";
}

export function renderHeader(s: TripState): string {
  const stopCount = s.days.reduce((n, d) => n + d.stops.length, 0);
  const endNote = s.days.length > 0 ? ` Last day ends at ${s.endLastDayAtLodging ? "lodging" : "its final stop"}.` : "";
  return (
    `TRIP rev${s.rev} — ${s.days.length} day${s.days.length === 1 ? "" : "s"}, ` +
    `${stopCount} stop${stopCount === 1 ? "" : "s"}, ${s.candidates.length} candidate${s.candidates.length === 1 ? "" : "s"}. ` +
    lodgingLabel(s) + endNote
  );
}

export function renderCandidates(s: TripState): string {
  if (s.candidates.length === 0) return "Candidates: none";
  return `Candidates: ${s.candidates.map((sid) => `[${sid}] ${s.places[s.stops[sid].place].name}${s.stops[sid].pending ? "*" : ""}`).join(", ")}`;
}

/**
 * The trip body: header, day blocks (or one-liners when compact), candidates,
 * warnings. `day` renders a single day in full detail.
 */
export function renderTrip(s: TripState, opts: { day?: number; compact?: boolean } = {}): string {
  if (s.days.length === 0 && s.candidates.length === 0) {
    return "Trip is empty — use plan_trip or add_place.";
  }
  const lines: string[] = [renderHeader(s)];
  if (pendingEdits(s).length > 0) lines.push("Marks: * = your pending edit");
  if (opts.day) {
    lines.push(...renderDayBlock(s, opts.day));
  } else if (opts.compact) {
    for (let d = 1; d <= s.days.length; d++) lines.push(renderDayOneLiner(s, d));
    lines.push("Pass day:N for stop detail");
  } else {
    for (let d = 1; d <= s.days.length; d++) lines.push(...renderDayBlock(s, d));
  }
  lines.push(renderCandidates(s));
  lines.push(renderWarnings(s));
  return lines.join("\n");
}
