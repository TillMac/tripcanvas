// Derived schedule (CONTEXT.md: "computed timeline of a day — never edited
// directly"). Reuses the ported computeSchedule for clocking/free/overflow by
// feeding every leg as precomputed minutes; leg minutes come from the matrix
// when the pair is covered, else haversine × mode speed marked approximate.
import { haversineKm, estimateMinutes } from "../ported/geo.js";
import { computeSchedule, parseHHMM, type SchedItemInput } from "../ported/schedule-ops.js";
import { UNREASONABLE_SECONDS } from "../ported/route-ops.js";
import type { TransitLeg } from "../ported/motis.js";
import type { LegMode, Pid, Sid, TripState } from "./types.js";

export const WALK_MAX_KM = 1.2;
/** The one leg-override key format (pair-keyed, §5). */
export const legKey = (from: Pid, to: Pid): string => `${from}>${to}`;
export const DRIVE_KMH = 25;
export const UNREASONABLE_MIN = UNREASONABLE_SECONDS / 60;

export interface LegInfo {
  fromPid: Pid;
  toPid: Pid;
  mode: LegMode;
  minutes: number;
  approx: boolean;
  transit?: TransitLeg;
}

export interface ScheduledStop {
  sid: Sid;
  arriveMin: number;
  departMin: number;
  legIn: LegInfo | null;
  freeAfterMin: number;
}

export interface DaySchedule {
  day: number;
  startMin: number;
  endMin: number;
  overflow: boolean;
  /** Any leg computed from estimates (matrix stale or pair uncovered). */
  approx: boolean;
  stops: ScheduledStop[];
  /** Return leg to the night's anchor; null when the day ends at its last stop. */
  backLeg: LegInfo | null;
  /** Legs longer than 40 minutes (warning, not error). */
  longLegs: LegInfo[];
}

function matrixMinutes(s: TripState, mode: "walk" | "drive", a: Pid, b: Pid): number | null {
  const m = s.matrices[mode];
  if (!m) return null;
  const i = s.matrices.ids.indexOf(a);
  const j = s.matrices.ids.indexOf(b);
  if (i < 0 || j < 0) return null;
  const sec = m[i]?.[j];
  return sec == null ? null : Math.round(sec / 60);
}

/** Straight-line km between two places. */
export function legKm(s: TripState, fromPid: Pid, toPid: Pid): number {
  const pa = s.places[fromPid];
  const pb = s.places[toPid];
  return haversineKm({ lat: pa.lat, lng: pa.lon }, { lat: pb.lat, lng: pb.lon });
}

/** Minutes for a pair in one mode, ignoring any override: matrix when the pair
 *  is covered, else haversine × mode speed marked approximate. */
export function modeMinutes(s: TripState, mode: LegMode, fromPid: Pid, toPid: Pid): { minutes: number; approx: boolean } {
  const lookup = mode === "transit" ? null : matrixMinutes(s, mode, fromPid, toPid);
  // A covered pair is a real routed time even while the set is being refreshed.
  if (lookup != null) return { minutes: lookup, approx: false };
  const km = legKm(s, fromPid, toPid);
  return { minutes: mode === "drive" ? Math.round((km / DRIVE_KMH) * 60) : estimateMinutes(km), approx: true };
}

export function legInfo(s: TripState, fromPid: Pid, toPid: Pid): LegInfo {
  const override = s.legOverrides[legKey(fromPid, toPid)];
  const mode: LegMode = override?.mode ?? (legKm(s, fromPid, toPid) <= WALK_MAX_KM ? "walk" : "drive");
  if (mode === "transit" && override?.transit) {
    return { fromPid, toPid, mode, minutes: override.transit.totalMin, approx: false, transit: override.transit };
  }
  return { fromPid, toPid, mode, ...modeMinutes(s, mode, fromPid, toPid) };
}

/** The pid sequence a day travels: [start anchor?, ...stops, end anchor?]. */
export function daySequence(s: TripState, day: number): { pids: Pid[]; startAnchor: Pid | null; endAnchor: Pid | null } {
  const d = s.days[day - 1];
  const D = s.days.length;
  const startAnchor = s.nights[day - 1] ?? null;
  const endAnchor =
    day < D ? (s.nights[day] ?? null) : s.endLastDayAtLodging ? (s.nights[D - 1] ?? null) : null;
  const pids = d.stops.map((sid) => s.stops[sid].place);
  return { pids, startAnchor, endAnchor };
}

export function computeDaySchedule(s: TripState, day: number): DaySchedule {
  const d = s.days[day - 1];
  const startMin = parseHHMM(d.start);
  const { startAnchor, endAnchor } = daySequence(s, day);

  // Build the leg list between consecutive sequence points.
  const seq: { pid: Pid; sid?: Sid }[] = [];
  if (startAnchor) seq.push({ pid: startAnchor });
  for (const sid of d.stops) seq.push({ pid: s.stops[sid].place, sid });
  if (endAnchor && d.stops.length > 0) seq.push({ pid: endAnchor });

  const legs: (LegInfo | null)[] = [null];
  for (let i = 1; i < seq.length; i++) legs.push(legInfo(s, seq[i - 1].pid, seq[i].pid));

  // Feed the ported scheduler: every leg as precomputed transit minutes.
  const items: SchedItemInput[] = [];
  const transitMin: (number | null)[] = [];
  const dwell: Record<string, number> = {};
  if (d.freeStartMin) items.push({ kind: "free", id: "day-free", durationMin: d.freeStartMin });
  seq.forEach((pt, i) => {
    const key = pt.sid ?? (i === 0 ? "@start" : "@end");
    items.push({ kind: "place", placeId: key, globalIndex: i });
    if (i > 0) transitMin.push(legs[i]!.minutes);
    dwell[key] = pt.sid ? s.stops[pt.sid].dwellMin : 0;
    if (pt.sid && s.stops[pt.sid].freeAfterMin > 0) {
      items.push({ kind: "free", id: `free-${pt.sid}`, durationMin: s.stops[pt.sid].freeAfterMin });
    }
  });

  const r = computeSchedule({
    items,
    dayStartMin: startMin,
    dwell,
    matrix: { walk: [], drive: [] },
    legModes: Array.from({ length: Math.max(0, seq.length - 1) }, () => "transit" as const),
    transitMin,
  });

  const bySid = new Map(r.items.filter((it) => it.kind === "place").map((it) => [it.ref, it]));
  const stops: ScheduledStop[] = d.stops.map((sid) => {
    const it = bySid.get(sid)!;
    const seqIdx = seq.findIndex((p) => p.sid === sid);
    return {
      sid,
      arriveMin: it.startMin,
      departMin: it.endMin,
      legIn: seqIdx > 0 ? legs[seqIdx]! : null,
      freeAfterMin: s.stops[sid].freeAfterMin,
    };
  });

  const backLeg = endAnchor && d.stops.length > 0 ? legs[legs.length - 1] : null;
  const realLegs = legs.filter((l): l is LegInfo => l !== null);
  return {
    day,
    startMin,
    endMin: r.dayEndMin,
    overflow: r.overflow,
    approx: realLegs.some((l) => l.approx),
    stops,
    backLeg,
    longLegs: realLegs.filter((l) => l.minutes > UNREASONABLE_MIN),
  };
}

export function tripSchedules(s: TripState): DaySchedule[] {
  return s.days.map((_, i) => computeDaySchedule(s, i + 1));
}

export function tripWarnings(s: TripState): { overflowDays: number[]; longLegCount: number; approx: boolean } {
  const scheds = tripSchedules(s);
  return {
    overflowDays: scheds.filter((x) => x.overflow).map((x) => x.day),
    longLegCount: scheds.reduce((n, x) => n + x.longLegs.length, 0),
    approx: scheds.some((x) => x.approx),
  };
}
