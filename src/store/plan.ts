// plan_trip orchestration (docs/design/tool-layer.md §3): one synchronous
// execute, atomic commit. Serial resolution through the ONE app-wide queue
// (3s fetch timeout + one retry inside the queue; 22s wall-clock deadline
// checked before every request), ephemeral resolving pins during the call,
// ONE pending ActionGroup at the end. The OSRM phases (tables before grouping,
// ensureFresh after the commit) share the SAME deadline: a hung router costs
// real times, never the tool call. Worst case ~23s < the 30s tool budget.
import { fmtHHMM } from "../ported/schedule-ops.js";
import type { PlaceCandidate } from "../ported/place-assert.js";
import { arrangeTrip, orderDayStops } from "./arrange.js";
import { renderWarnings } from "./handback.js";
import { normalizeQuery, type ResolveResult } from "./nominatim.js";
import { computeDaySchedule } from "./schedule.js";
import { DEFAULT_DWELL_MIN, initialTrip, type createTripStore } from "./store.js";
import type { DayRec, Pid, Place, Sid, Stop, TripState } from "./types.js";

export const PLAN_NAME_CAP = 12;
export const PLAN_DEADLINE_MS = 22_000;

export interface PlanArgs {
  places?: string[];
  days?: string[][];
  dayCount?: number;
  lodging?: string;
  dayStart?: string;
  replace?: boolean;
}

export interface PlanDeps {
  trip: Pick<ReturnType<typeof createTripStore>, "store" | "actions">;
  matrix: {
    ensureFresh(): Promise<void>;
    fetchTablesFor?(
      places: { id: string; lat: number; lon: number }[],
    ): Promise<{ walk?: import("../ported/osrm.js").DurationMatrix; drive?: import("../ported/osrm.js").DurationMatrix; ids: string[] } | null>;
  };
  nominatim: {
    resolve(query: string, opts?: { deadline?: number }): Promise<ResolveResult>;
    uncachedCount?(queries: string[]): number;
  };
  now?: () => number;
}

const err = (msg: string) => `ERROR: ${msg}`;

/** Resolve with `p`, or with `fallback` once `ms` elapse (rejections count as fallback). */
function bounded<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    const settle = (v: T) => {
      clearTimeout(timer);
      resolve(v);
    };
    p.then(settle, () => settle(fallback));
  });
}

export async function planTrip(deps: PlanDeps, args: PlanArgs): Promise<string> {
  const { trip, nominatim } = deps;
  const s0 = trip.store.getState();

  // ── 1. validate ──────────────────────────────────────────────────────────
  if (!args.places && !args.days) return err("give places with dayCount, or days.");
  if (args.places && args.days) return err("give places OR days, not both.");
  if (args.places && !args.dayCount) return err("dayCount is required with places (1-7).");
  const dayCount = args.days ? args.days.length : args.dayCount!;
  if (dayCount < 1 || dayCount > 7) return err(`dayCount must be 1-7 (got ${dayCount}).`);
  if (args.dayStart !== undefined && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(args.dayStart)) {
    return err("dayStart must be HH:MM 24h.");
  }
  const flat = (args.places ?? args.days!.flat()).map((x) => x.trim()).filter(Boolean);
  const uniqueNames = [...new Map(flat.map((n) => [normalizeQuery(n), n])).values()];
  // §3 step 1: the cap counts RESOLVE JOBS — unique uncached names (+ lodging).
  // Geocached names cost no queue slot, so a warm rerun of a big trip passes.
  const allNames = [...uniqueNames, ...(args.lodging ? [args.lodging] : [])];
  const resolveJobs = nominatim.uncachedCount?.(allNames) ?? allNames.length;
  if (resolveJobs > PLAN_NAME_CAP) {
    return err(
      `${resolveJobs} names exceeds the ${PLAN_NAME_CAP}-per-call cap (resolving is rate-limited to ~1/s) — plan the ${PLAN_NAME_CAP} most important, add the rest with add_place.`,
    );
  }
  if (flat.length === 0) return err("no place names given.");
  const hasTrip = s0.days.some((d) => d.stops.length > 0) || s0.candidates.length > 0;
  if (hasTrip && !args.replace) return err(`a trip exists (rev ${s0.rev}) — pass replace:true or edit it instead.`);

  // ── 2-3. resolve serially with the wall-clock deadline; pins drop live ───
  const now = deps.now ?? Date.now;
  const deadline = now() + PLAN_DEADLINE_MS;
  const remaining = () => Math.max(0, deadline - now());
  const resolved = new Map<string, { place: PlaceCandidate; cached: boolean }>();
  const unresolved: string[] = [];
  let lodgingPlace: PlaceCandidate | null = null;
  let lodgingPid: Pid | null = null;
  const pins: { name: string; lat: number; lon: number }[] = [];
  const dropPin = (place: PlaceCandidate) => {
    pins.push({ name: place.name, lat: place.lat!, lon: place.lng! });
    trip.actions.setResolvingPins(pins.slice());
  };

  try {
    if (args.lodging) {
      const r = await nominatim.resolve(args.lodging, { deadline });
      if (r.ok) {
        lodgingPlace = r.place;
        dropPin(r.place);
      } else {
        unresolved.push(`'${args.lodging}' (lodging)`);
      }
    }
    for (const name of uniqueNames) {
      const r = await nominatim.resolve(name, { deadline });
      if (r.ok) {
        resolved.set(normalizeQuery(name), { place: r.place, cached: r.cached });
        dropPin(r.place);
      } else {
        unresolved.push(r.kind === "deadline" ? `'${name}' (time limit)` : `'${name}'`);
      }
    }

    if (resolved.size < 2) {
      return err(`only ${resolved.size} name${resolved.size === 1 ? "" : "s"} resolved — trip unchanged.`);
    }

    // ── 4-5. build the new trip: ids, grouping, ordering ───────────────────
    const start = args.dayStart ?? "09:00";
    let nextP = s0.nextP;
    let nextS = s0.nextS;
    const places: Record<Pid, Place> = {};
    const stops: Record<Sid, Stop> = {};
    const sidByNorm = new Map<string, Sid>();
    if (lodgingPlace) {
      lodgingPid = `p${nextP++}`;
      places[lodgingPid] = {
        id: lodgingPid, name: lodgingPlace.name, lat: lodgingPlace.lat!, lon: lodgingPlace.lng!,
        query: args.lodging!,
      };
    }
    for (const [norm, { place }] of resolved) {
      const pid = `p${nextP++}`;
      const sid = `s${nextS++}`;
      places[pid] = { id: pid, name: place.name, lat: place.lat!, lon: place.lng!, query: norm };
      stops[sid] = { place: pid, dwellMin: DEFAULT_DWELL_MIN, freeAfterMin: 0 };
      sidByNorm.set(norm, sid);
    }
    const nights: (Pid | null)[] = Array.from({ length: dayCount }, () => lodgingPid);

    // §3 step 4: two OSRM /table calls in parallel over all resolved places +
    // lodging, awaited inline — grouping and ordering run on REAL travel
    // times. Failure falls back to haversine estimates (never fatal).
    const tables = deps.matrix.fetchTablesFor && remaining() > 0
      ? await bounded(
          deps.matrix.fetchTablesFor(Object.values(places).map((pl) => ({ id: pl.id, lat: pl.lat, lon: pl.lon }))),
          remaining(),
          null,
        )
      : null;
    let days: DayRec[];
    let capOverflow: Sid[] = [];
    const synthetic: TripState = { ...initialTrip(), places, stops, nights };
    if (tables) {
      synthetic.matrices = { walk: tables.walk, drive: tables.drive, ids: tables.ids, forHash: "", stale: false };
    }
    if (args.days) {
      // Pre-grouped: grouping kept verbatim; each day still ordered from lodging.
      days = args.days.map((group) => {
        const sids = group
          .map((n) => sidByNorm.get(normalizeQuery(n.trim())))
          .filter((x): x is Sid => !!x);
        return { start, stops: orderDayStops(synthetic, sids, lodgingPid) };
      });
    } else {
      synthetic.days = [{ start, stops: [...sidByNorm.values()] }];
      const r = arrangeTrip(synthetic, dayCount);
      if ("error" in r) return err(r.error);
      days = r.days.map((d) => ({ ...d, start }));
      capOverflow = r.overflow;
    }

    // ── 6. ONE atomic pending ActionGroup ──────────────────────────────────
    trip.store.setState({ nextP, nextS });
    const stopCount = Object.keys(stops).length - capOverflow.length;
    trip.actions.planCommit(
      "agent",
      { places, stops, days, nights, candidates: capOverflow },
      `planned ${dayCount} day${dayCount > 1 ? "s" : ""}, ${stopCount} stops via plan_trip${args.replace ? " (replaced the previous trip)" : ""}`,
    );
  } finally {
    trip.actions.setResolvingPins([]);
  }

  if (remaining() > 0) await bounded(deps.matrix.ensureFresh(), remaining(), undefined);

  // ── 7. result summary ────────────────────────────────────────────────────
  const s2 = trip.store.getState();
  const e = s2.log[s2.log.length - 1]?.editId ?? "?";
  const placedCount = s2.days.reduce((n, d) => n + d.stops.length, 0);
  const freshCount = [...resolved.values()].filter((x) => !x.cached).length;
  const cachedCount = resolved.size - freshCount;
  const dayLines = s2.days
    .map((d, i) => {
      const sched = computeDaySchedule(s2, i + 1);
      const names = d.stops.map((sid) => s2.places[s2.stops[sid].place].name).join(", ");
      return `D${i + 1} ${d.start}-${fmtHHMM(sched.endMin)}: ${names || "(empty)"}.`;
    })
    .join(" ");
  let out =
    `Planned ${s2.days.length} days, ${placedCount} stops (${freshCount} fresh, ${cachedCount} cached) — ` +
    `all pending as ${e}; the human is reviewing on the map. ${dayLines}`;
  if (!lodgingPid) out += " No lodging set — set_lodging to anchor days.";
  if (s2.candidates.length > 0) out += ` ${s2.candidates.length} extra stop${s2.candidates.length > 1 ? "s" : ""} parked as candidates (5/day cap).`;
  if (unresolved.length > 0) out += ` Unresolved (not added): ${unresolved.join(", ")} — retry a fuller name via add_place.`;
  out += ` ${renderWarnings(s2)}.`;
  return out;
}
