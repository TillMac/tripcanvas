// Transit legs (T9): fetch a MOTIS/transitous itinerary for one leg and apply
// it as a pair-keyed override — the same path for the human's cycle button and
// the agent's set_leg_mode. Retry once; failure keeps the leg's old mode.
import { motisPlanUrl, parseMotisItinerary, withDestinationName, type TransitLeg } from "../ported/motis.js";
import { daySequence, legInfo, legKey } from "./schedule.js";
import type { createTripStore } from "./store.js";
import type { Actor, Pid, Place, Sid, TripState } from "./types.js";

export const TRANSIT_TIMEOUT_MS = 8000;

export type FetchTransit = (from: Place, to: Place) => Promise<TransitLeg | null>;

/** Next weekday at 10:00 local, as ISO — a stable, plausible departure so
 *  transit frequencies are typical. ponytail: real per-leg departure times
 *  would need trip dates the product deliberately doesn't have. */
export function nearFutureWeekdayISO(now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

export function makeTransitFetcher(deps: { fetchFn?: typeof fetch; timeoutMs?: number } = {}): FetchTransit {
  const fetchFn = deps.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = deps.timeoutMs ?? TRANSIT_TIMEOUT_MS;
  async function once(from: Place, to: Place): Promise<TransitLeg | null> {
    const url = motisPlanUrl(from.lat, from.lon, to.lat, to.lon, nearFutureWeekdayISO());
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const leg = parseMotisItinerary(await res.json());
      return withDestinationName(leg, to.name);
    } finally {
      clearTimeout(timer);
    }
  }
  return async (from, to) => {
    try {
      return await once(from, to);
    } catch {
      return await once(from, to); // retry once (flaky transitous nodes)
    }
  };
}

export interface TransitLegTarget {
  fromPid: Pid;
  toPid: Pid;
  /** The stop this leg is filed under (carries the agent's pending mark): the
   *  arriving stop, or the departing one for the return to lodging. */
  sid: Sid;
  fromLabel: string; // "[s2]" or "lodging"
  toLabel: string; // "[s3]" or "lodging"
}

/** Resolve the leg arriving at toSid on a day: previous stop or the lodging anchor. */
export function legTarget(s: TripState, day: number, toSid: Sid): TransitLegTarget | { error: string } {
  const d = s.days[day - 1];
  const i = d.stops.indexOf(toSid);
  if (i < 0) return { error: `[${toSid}] is not on day ${day}.` };
  const toLabel = `[${toSid}]`;
  if (i === 0) {
    const anchor = s.nights[day - 1];
    if (!anchor) return { error: `day ${day} has no lodging — its first stop has no arriving leg.` };
    return { fromPid: anchor, toPid: s.stops[toSid].place, sid: toSid, fromLabel: "lodging", toLabel };
  }
  const fromSid = d.stops[i - 1];
  return { fromPid: s.stops[fromSid].place, toPid: s.stops[toSid].place, sid: toSid, fromLabel: `[${fromSid}]`, toLabel };
}

/** The day's return leg, last stop -> the night's lodging (none when the day ends at its last stop). */
export function backLegTarget(s: TripState, day: number): TransitLegTarget | { error: string } {
  const d = s.days[day - 1];
  const last = d.stops[d.stops.length - 1];
  if (!last) return { error: `day ${day} has no stops.` };
  const { endAnchor } = daySequence(s, day);
  if (!endAnchor) return { error: `day ${day} ends at [${last}] — no lodging to return to.` };
  return { fromPid: s.stops[last].place, toPid: endAnchor, sid: last, fromLabel: `[${last}]`, toLabel: "lodging" };
}

/** The one step rendering for agent results:
 *  "walk 4m to Ueno Sta; Ginza Line toward Shibuya, off at Tawaramachi". */
export function transitSteps(leg: TransitLeg): string {
  return leg.steps
    .map((st) =>
      st.mode === "walk"
        ? `walk ${st.durationMin}m to ${st.toName}`
        : `${st.line ?? "line"}${st.headsign ? ` toward ${st.headsign}` : ""}, off at ${st.toName}`,
    )
    .join("; ");
}

/** Resolve the leg named by the stop it DEPARTS from — `[s#]`, 'lodging' for
 *  the day's first leg, the day's last stop for the return to lodging. The one
 *  addressing shared by set_leg_mode and get_leg_options; errors are the
 *  wording those tools return. */
export function legFromStop(s: TripState, day: number, fromStop: Sid): TransitLegTarget | { error: string } {
  if (day < 1 || day > s.days.length) return { error: `day ${day} out of range (trip has ${s.days.length}).` };
  const d = s.days[day - 1];
  if (d.stops.length === 0) return { error: `day ${day} has no stops.` };
  if (fromStop === "lodging") {
    if (!s.nights[day - 1]) return { error: `day ${day} has no lodging — its first leg does not exist.` };
    return legTarget(s, day, d.stops[0]);
  }
  const i = d.stops.indexOf(fromStop);
  if (i < 0) return { error: `no stop [${fromStop}] on day ${day} — ids come from get_itinerary.` };
  if (i === d.stops.length - 1) return backLegTarget(s, day);
  return legTarget(s, day, d.stops[i + 1]);
}

export type ApplyTransitResult =
  | { ok: true; leg: TransitLeg; target: TransitLegTarget }
  | { ok: false; message: string };

/** Fetch and apply a transit override for one leg: the leg arriving at a stop
 *  (named by its sid), or any resolved target (e.g. backLegTarget). */
export async function applyTransitLeg(
  trip: Pick<ReturnType<typeof createTripStore>, "store" | "actions">,
  fetchTransit: FetchTransit,
  actor: Actor,
  day: number,
  target: Sid | TransitLegTarget,
): Promise<ApplyTransitResult> {
  const s = trip.store.getState();
  const t = typeof target === "string" ? legTarget(s, day, target) : target;
  if ("error" in t) return { ok: false, message: `ERROR: ${t.error}` };
  const from = s.places[t.fromPid];
  const to = s.places[t.toPid];

  const cur = legInfo(s, t.fromPid, t.toPid);
  let leg: TransitLeg | null;
  try {
    leg = await fetchTransit(from, to);
  } catch {
    return { ok: false, message: "ERROR: transit service unreachable — mode unchanged, try again." };
  }
  if (!leg) {
    return {
      ok: false,
      message: `ERROR: no transit route found — leg stays ${cur.mode} (${cur.minutes}m).`,
    };
  }
  trip.actions.setLegOverride(
    actor,
    legKey(t.fromPid, t.toPid),
    { mode: "transit", transit: leg },
    actor === "agent" ? t.sid : undefined,
    `leg into ${t.toLabel} -> transit (${leg.totalMin}m, ${leg.transfers} transfer${leg.transfers === 1 ? "" : "s"})`,
  );
  return { ok: true, leg, target: t };
}
