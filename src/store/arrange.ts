// Arrange (CONTEXT.md): recompute day assignment and stop order for the whole
// trip from travel times — the same function whether the human clicks it or
// the agent asks (ADR-0002). Deterministic: farthest-first seeds, nearest-seed
// assignment capped at 5 stops/day (extras become candidates), greedy
// nearest-neighbour from each night's lodging, then 2-opt.
import { haversineKm } from "../ported/geo.js";
import type { Actor, DayRec, Pid, Sid, TripState } from "./types.js";
import { DEFAULT_DAY_START } from "./store.js";

export const MAX_ARRANGE_PER_DAY = 5;

export interface ArrangeOutcome {
  days: DayRec[];
  nights: (Pid | null)[];
  candidates: Sid[];
  /** Stops demoted to candidates by the 5-per-day cap. */
  overflow: Sid[];
}

function driveMinutes(s: TripState, a: Pid, b: Pid): number {
  const m = s.matrices.drive;
  if (m) {
    const i = s.matrices.ids.indexOf(a);
    const j = s.matrices.ids.indexOf(b);
    const sec = i >= 0 && j >= 0 ? m[i]?.[j] : null;
    if (sec != null) return sec / 60;
  }
  const pa = s.places[a];
  const pb = s.places[b];
  return (haversineKm({ lat: pa.lat, lng: pa.lon }, { lat: pb.lat, lng: pb.lon }) / 25) * 60;
}

export function orderDayStops(s: TripState, sids: Sid[], anchor: Pid | null): Sid[] {
  if (sids.length <= 1) return sids.slice();
  const pid = (sid: Sid) => s.stops[sid].place;
  // Greedy nearest-neighbour from the anchor (or the first stop).
  const remaining = sids.slice();
  const path: Sid[] = [];
  let cur: Pid | null = anchor;
  if (!cur) {
    path.push(remaining.shift()!);
    cur = pid(path[0]);
  }
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = driveMinutes(s, cur, pid(remaining[i]));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const next = remaining.splice(best, 1)[0];
    path.push(next);
    cur = pid(next);
  }
  // 2-opt (path version, anchor fixed as virtual start).
  const dist = (a: Sid | null, b: Sid) =>
    a === null ? (anchor ? driveMinutes(s, anchor, pid(b)) : 0) : driveMinutes(s, pid(a), pid(b));
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < path.length - 1; i++) {
      for (let k = i + 1; k < path.length; k++) {
        const prev = i === 0 ? null : path[i - 1];
        const after = k + 1 < path.length ? path[k + 1] : null;
        const before = dist(prev, path[i]) + (after ? driveMinutes(s, pid(path[k]), pid(after)) : 0);
        const flipped = dist(prev, path[k]) + (after ? driveMinutes(s, pid(path[i]), pid(after)) : 0);
        if (flipped + 1e-9 < before) {
          path.splice(i, k - i + 1, ...path.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return path;
}

export function arrangeTrip(s: TripState, dayCountOpt?: number): ArrangeOutcome | { error: string } {
  const placed = s.days.flatMap((d) => d.stops);
  if (placed.length < 2) return { error: "fewer than 2 stops — nothing to arrange." };
  const D = Math.min(7, Math.max(1, dayCountOpt ?? s.days.length));
  const pid = (sid: Sid) => s.stops[sid].place;

  // nights resized: keep existing anchors, pad with the last known one.
  const nights: (Pid | null)[] = Array.from({ length: D }, (_, i) => s.nights[i] ?? s.nights[s.nights.length - 1] ?? null);

  // Farthest-first seeds, deterministically started from the stop farthest
  // from the first night's lodging (or the first placed stop).
  const seeds: Sid[] = [];
  const anchor0 = nights[0];
  let first = placed[0];
  if (anchor0) {
    let bestD = -1;
    for (const sid of placed) {
      const d = driveMinutes(s, anchor0, pid(sid));
      if (d > bestD) {
        bestD = d;
        first = sid;
      }
    }
  }
  seeds.push(first);
  while (seeds.length < Math.min(D, placed.length)) {
    let best: Sid | null = null;
    let bestD = -1;
    for (const sid of placed) {
      if (seeds.includes(sid)) continue;
      const dMin = Math.min(...seeds.map((seed) => driveMinutes(s, pid(seed), pid(sid))));
      if (dMin > bestD) {
        bestD = dMin;
        best = sid;
      }
    }
    if (!best) break;
    seeds.push(best);
  }

  // Assign to the nearest seed with capacity; closest assignments first so
  // far-flung extras (not central ones) overflow to candidates.
  const groups: Sid[][] = seeds.map(() => []);
  const overflow: Sid[] = [];
  const ranked = placed
    .map((sid) => {
      const ds = seeds.map((seed, g) => ({ g, d: driveMinutes(s, pid(seed), pid(sid)) }));
      ds.sort((a, b) => a.d - b.d);
      return { sid, prefs: ds };
    })
    .sort((a, b) => a.prefs[0].d - b.prefs[0].d);
  for (const { sid, prefs } of ranked) {
    const open = prefs.find((p) => groups[p.g].length < MAX_ARRANGE_PER_DAY);
    if (open) groups[open.g].push(sid);
    else overflow.push(sid);
  }

  // Order each day from its night's start anchor; keep existing day starts.
  const days: DayRec[] = Array.from({ length: D }, (_, i) => ({
    start: s.days[i]?.start ?? DEFAULT_DAY_START,
    stops: groups[i] ? orderDayStops(s, groups[i], nights[i] ?? null) : [],
    ...(s.days[i]?.freeStartMin ? { freeStartMin: s.days[i].freeStartMin } : {}),
  }));

  return { days, nights, candidates: [...s.candidates, ...overflow], overflow };
}

/** Shared orchestration for the Arrange button and the arrange_days tool. */
export async function runArrange(
  trip: { store: { getState(): TripState }; actions: { applyArrangement(actor: Actor, next: { days: DayRec[]; nights: (Pid | null)[]; candidates: Sid[] }, summary: string): void } },
  matrixService: { ensureFresh(): Promise<void> } | null,
  actor: Actor,
  dayCount?: number,
): Promise<ArrangeOutcome | { error: string }> {
  let matrixNote = false;
  try {
    await matrixService?.ensureFresh();
  } catch {
    matrixNote = true;
  }
  const r = arrangeTrip(trip.store.getState(), dayCount);
  if ("error" in r) return r;
  const counts = r.days.map((d) => d.stops.length).join("+");
  trip.actions.applyArrangement(
    actor,
    r,
    `arranged ${r.days.length} day${r.days.length > 1 ? "s" : ""} (${counts} stops)${matrixNote ? " — times approximate" : ""}`,
  );
  return r;
}
