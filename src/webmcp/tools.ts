// The WebMCP tool layer (docs/design/tool-layer.md §1-§2). Every execute is a
// thin adapter: zod-parse -> the SAME exported store action the UI buttons
// call (actor "agent") -> await the matrix -> format the result string.
// Failures are explanatory "ERROR: ..." strings; tools are never unregistered.
import { z } from "zod";
import { fmtHHMM } from "../ported/schedule-ops.js";
import type { PlaceCandidate } from "../ported/place-assert.js";
import { runArrange } from "../store/arrange.js";
import { planTrip } from "../store/plan.js";
import { applyTransitLeg, legFromStop, transitSteps, type FetchTransit } from "../store/transit.js";
import { computeDaySchedule } from "../store/schedule.js";
import type { createTripStore } from "../store/store.js";
import type { ResolveResult } from "../store/nominatim.js";
import type { TripState } from "../store/types.js";
import { buildReadTools } from "./readTools.js";
import { PLANNING_GUIDE } from "./planningGuide.js";
import type { RegisterToolOptions } from "./modelContext.js";

export interface ToolDeps {
  trip: Pick<ReturnType<typeof createTripStore>, "store" | "actions">;
  matrix: {
    ensureFresh(): Promise<void>;
    /** plan_trip's inline pre-grouping tables (§3 step 4); optional in fakes. */
    fetchTablesFor?(
      places: { id: string; lat: number; lon: number }[],
    ): Promise<{ walk?: import("../ported/osrm.js").DurationMatrix; drive?: import("../ported/osrm.js").DurationMatrix; ids: string[] } | null>;
  };
  nominatim: {
    resolve(query: string, opts?: { deadline?: number }): Promise<ResolveResult>;
    uncachedCount?(queries: string[]): number;
  };
  fetchTransit: FetchTransit;
}

import { err, sidArg, wrap, zodErr } from "./result.js";
import { toPlaceInput } from "../store/nominatim.js";
import { legKey } from "../store/schedule.js";
import { DEFAULT_DWELL_MIN } from "../store/store.js";

// ── formatting helpers ─────────────────────────────────────────────────────
function resolvedLabel(place: PlaceCandidate): string {
  const city = place.city;
  return city && !place.name.toLowerCase().includes(city.toLowerCase())
    ? `${place.name} (${city})`
    : place.name;
}

function endsPhrase(s: TripState, day: number, withNoOverflow = false): string {
  const sched = computeDaySchedule(s, day);
  const t = fmtHHMM(sched.endMin);
  if (sched.overflow) return `D${day} ends ${t} — WARNING: past 22:00`;
  return `D${day} ends ${t}${withNoOverflow ? ", no overflow" : ""}`;
}

function lastEditId(s: TripState): string {
  return s.log[s.log.length - 1]?.editId ?? "?";
}

// ── tools ──────────────────────────────────────────────────────────────────
export function buildTools(deps: ToolDeps): RegisterToolOptions[] {
  const { trip, matrix, nominatim } = deps;
  const state = () => trip.store.getState();

  const addPlace: RegisterToolOptions = {
    name: "add_place",
    description:
      "Resolve one free-text place name and add it: to a day at the best position by travel time (or a fixed position), or as a candidate when day is omitted. Takes about 1s for an uncached name. Returns the resolved name — check it matches what you meant; if wrong, move it to candidates and retry with a fuller name like 'Ghibli Museum, Mitaka'. The stop lands pending for the human.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Free-text place name; include the city for accuracy." },
        day: { type: "number", minimum: 1, description: "1-based target day; omit to add as a candidate." },
        position: { type: "number", minimum: 1, description: "1-based slot in the day; omit for best insertion by travel time." },
        dwellMinutes: { type: "number", minimum: 0, description: "Minutes at the stop. Default 60." },
      },
      required: ["name"],
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: wrap(async (args) => {
      const p = z
        .object({
          name: z.string().min(1),
          day: z.number().int().optional(),
          position: z.number().int().min(1).optional(),
          dwellMinutes: z.number().int().min(0).optional(),
        })
        .safeParse(args);
      if (!p.success) return zodErr(p.error);
      const s = state();
      if (p.data.day !== undefined && (p.data.day < 1 || p.data.day > s.days.length)) {
        return err(`day ${p.data.day} out of range (trip has ${s.days.length}).`);
      }
      const r = await nominatim.resolve(p.data.name);
      if (!r.ok) return err(r.message);
      const res = trip.actions.addResolvedStop(
        "agent",
        toPlaceInput(r.place, p.data.name),
        { day: p.data.day, position: p.data.position, dwellMin: p.data.dwellMinutes },
      );
      await matrix.ensureFresh();
      const s2 = state();
      const e = lastEditId(s2);
      if (res.day === 0) return `Added [${res.sid}] ${resolvedLabel(r.place)} as a candidate [pending ${e}].`;
      const dwell = p.data.dwellMinutes ?? DEFAULT_DWELL_MIN;
      return `Added [${res.sid}] ${resolvedLabel(r.place)} to D${res.day} pos${res.position}, dwell ${dwell} [pending ${e}]. ${endsPhrase(s2, res.day, true)}.`;
    }),
  };

  const moveStop: RegisterToolOptions = {
    name: "move_stop",
    description:
      "Move a stop to another day or position, place a candidate onto a day, or pass day 0 to unassign a stop into candidates (nothing is deleted; candidates keep it recoverable). Omit position for best insertion by travel time. Ids come from get_itinerary. Affected days reschedule immediately; the result reports their new end times and any overflow. Pending until the human accepts or reverts.",
    inputSchema: {
      type: "object",
      properties: {
        stop: { type: "string", description: "[s#] or [c#] id from get_itinerary." },
        day: { type: "number", minimum: 0, description: "Target day 1..N, or 0 to send it to candidates." },
        position: { type: "number", minimum: 1, description: "1-based slot; omit for best insertion by travel time." },
      },
      required: ["stop", "day"],
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: wrap(async (args) => {
      const p = z
        .object({ stop: sidArg, day: z.number().int(), position: z.number().int().min(1).optional() })
        .safeParse(args);
      if (!p.success) return zodErr(p.error);
      const r = trip.actions.moveStop("agent", p.data.stop, p.data.day, p.data.position);
      if ("error" in r) return err(r.error);
      await matrix.ensureFresh();
      const s2 = state();
      const e = lastEditId(s2);
      if (r.to.day === 0) {
        return `Unassigned [${p.data.stop}] to candidates as [${r.sid}] [pending ${e}]; ${endsPhrase(s2, r.from.day)}.`;
      }
      if (r.from.day === 0) {
        return `Placed candidate [${p.data.stop}] on D${r.to.day} pos${r.to.index + 1} as [${r.sid}] [pending ${e}]. ${endsPhrase(s2, r.to.day, true)}.`;
      }
      const days = r.from.day === r.to.day ? [r.to.day] : [r.from.day, r.to.day];
      return `Moved [${r.sid}]: D${r.from.day} pos${r.from.index + 1} -> D${r.to.day} pos${r.to.index + 1} [pending ${e}]. ${days.map((d) => endsPhrase(s2, d)).join("; ")}.`;
    }),
  };

  const setTimes: RegisterToolOptions = {
    name: "set_times",
    description:
      "Set a day's timing inputs: dayStart (HH:MM) moves when the day leaves its lodging; stop plus dwellMinutes changes minutes spent there; freeMinutesAfter inserts unscheduled time after that stop. The schedule recomputes at once. Use when get_itinerary warns a day overflows past 22:00 — start earlier or trim dwell. Pending until the human accepts.",
    inputSchema: {
      type: "object",
      properties: {
        day: { type: "number", minimum: 1, description: "Day 1..N." },
        dayStart: { type: "string", description: "New HH:MM 24h start for the day." },
        stop: { type: "string", description: "[s#] id to retime; required with dwellMinutes or freeMinutesAfter." },
        dwellMinutes: { type: "number", minimum: 0, description: "New minutes spent at the stop." },
        freeMinutesAfter: { type: "number", minimum: 0, description: "Unscheduled minutes after the stop; 0 removes the block." },
      },
      required: ["day"],
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: wrap(async (args) => {
      const p = z
        .object({
          day: z.number().int(),
          dayStart: z.string().optional(),
          stop: sidArg.optional(),
          dwellMinutes: z.number().int().min(0).optional(),
          freeMinutesAfter: z.number().int().min(0).optional(),
        })
        .safeParse(args);
      if (!p.success) return zodErr(p.error);
      if (p.data.dayStart !== undefined && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(p.data.dayStart)) {
        return err("time must be HH:MM 24h.");
      }
      if ((p.data.dwellMinutes !== undefined || p.data.freeMinutesAfter !== undefined) && !p.data.stop) {
        return err("give dayStart, or stop with dwellMinutes/freeMinutesAfter.");
      }
      const r = trip.actions.setTimes("agent", p.data.day, {
        dayStart: p.data.dayStart,
        sid: p.data.stop,
        dwellMin: p.data.dwellMinutes,
        freeAfterMin: p.data.freeMinutesAfter,
      });
      if ("error" in r) return err(r.error);
      const s2 = state();
      const e = lastEditId(s2);
      const parts: string[] = [];
      if (p.data.dayStart) parts.push(`D${p.data.day} starts ${p.data.dayStart}`);
      if (r.sid && p.data.dwellMinutes !== undefined) parts.push(`[${r.sid}] dwell ${r.prevDwell} -> ${p.data.dwellMinutes}`);
      if (r.sid && p.data.freeMinutesAfter !== undefined) parts.push(`free after [${r.sid}] ${r.prevFree} -> ${p.data.freeMinutesAfter} min`);
      return `${parts.join("; ")} [pending ${e}]. ${endsPhrase(s2, p.data.day)}.`;
    }),
  };

  const setLodging: RegisterToolOptions = {
    name: "set_lodging",
    description:
      "Resolve a lodging name and anchor nights to it. Night 0 is where Day 1 starts; night N is where day N ends and day N+1 starts. Omit nights to set every night. Day schedules recompute from their anchors; days with no lodging start at their first stop. Returns the resolved name — verify it matches. Pending until the human accepts.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lodging name or address; include the city." },
        nights: { type: "array", items: { type: "number", minimum: 0 }, description: "Night numbers to anchor; omit for every night." },
      },
      required: ["name"],
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: wrap(async (args) => {
      const p = z
        .object({ name: z.string().min(1), nights: z.array(z.number().int()).optional() })
        .safeParse(args);
      if (!p.success) return zodErr(p.error);
      const s = state();
      const D = s.days.length;
      if (D === 0) return err("trip has no days yet — plan_trip or add_place first.");
      for (const n of p.data.nights ?? []) {
        if (n < 0 || n >= D) return err(`night ${n} out of range (nights 0-${D - 1}).`);
      }
      const r = await nominatim.resolve(p.data.name);
      if (!r.ok) return err(r.message);
      const res = trip.actions.setLodging("agent", toPlaceInput(r.place, p.data.name), p.data.nights);
      if ("error" in res) return err(res.error);
      await matrix.ensureFresh();
      const s2 = state();
      const e = lastEditId(s2);
      const all = res.nights.length === D;
      const nightsLabel = all
        ? `nights 0-${D - 1}`
        : `night${res.nights.length > 1 ? "s" : ""} ${res.nights.join(", ")}`;
      const ends = s2.days.map((_, i) => (i === 0 ? endsPhrase(s2, 1) : `D${i + 1} ${fmtHHMM(computeDaySchedule(s2, i + 1).endMin)}`)).join(", ");
      return `${resolvedLabel(r.place)} anchored for ${nightsLabel} [pending ${e}].${all ? " All days start/end there." : ""} ${ends}.`;
    }),
  };

  const arrangeDays: RegisterToolOptions = {
    name: "arrange_days",
    description:
      "Regroup and reorder every placed stop across days by travel time: stops cluster into days, each day is ordered from its lodging, schedules recompute — exactly what the human's Arrange days button does. Dwell survives; leg-mode choices survive where the stop pair stays adjacent. Candidates untouched. Pass dayCount to grow or shrink the trip. Use after several adds rather than optimising stop by stop. One pending edit, one-click revert.",
    inputSchema: {
      type: "object",
      properties: {
        dayCount: { type: "number", minimum: 1, maximum: 7, description: "Target number of days 1-7; omit to keep the current count." },
      },
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: wrap(async (args) => {
      const p = z.object({ dayCount: z.number().int().min(1).max(7).optional() }).safeParse(args);
      if (!p.success) return zodErr(p.error);
      const before = state();
      const prevCand = before.candidates.length;
      const r = await runArrange(trip, matrix, "agent", p.data.dayCount);
      if ("error" in r) return err(r.error);
      await matrix.ensureFresh();
      const s2 = state();
      const e = lastEditId(s2);
      const dayBits = s2.days
        .map((d, i) => `D${i + 1} [${d.stops.join(" ")}] ends ${fmtHHMM(computeDaySchedule(s2, i + 1).endMin)}`)
        .join(". ");
      const overflowDays = s2.days.map((_, i) => i + 1).filter((d) => computeDaySchedule(s2, d).overflow);
      const longLegs = s2.days.reduce((n, _, i) => n + computeDaySchedule(s2, i + 1).longLegs.length, 0);
      const capNote = r.overflow.length ? ` (+${r.overflow.length} over the 5-stop cap moved there)` : "";
      return (
        `Arranged ${s2.days.length} day${s2.days.length > 1 ? "s" : ""} [pending ${e}]. ${dayBits}. ` +
        `Candidates untouched: ${prevCand}${capNote}. ` +
        `Overflow: ${overflowDays.length ? `day ${overflowDays.join(", ")} past 22:00` : "none"}; ` +
        `legs over 40m: ${longLegs || "none"}.`
      );
    }),
  };

  const planTripTool: RegisterToolOptions = {
    name: "plan_trip",
    description:
      "Plan a whole trip from place names. Give places plus dayCount, or days you grouped yourself (grouping kept; each day is still ordered by travel time). Max 12 names per call including lodging — resolving is rate-limited (~1/s). The page resolves names, assigns days, orders each day from its lodging, and computes a timed schedule. Unresolved names are skipped and listed, never fatal. Everything lands pending until the human reviews it. Overwriting an existing trip needs replace:true.",
    inputSchema: {
      type: "object",
      properties: {
        places: { type: "array", items: { type: "string" }, description: "Flat place names, e.g. 'Ghibli Museum, Mitaka'. Use with dayCount, or give days instead. 12 names max incl. lodging." },
        days: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Pre-grouped names, one inner array per day. Grouping kept; each day still reordered by travel time." },
        dayCount: { type: "number", minimum: 1, maximum: 7, description: "Number of days, 1-7. Required with places; ignored with days." },
        lodging: { type: "string", description: "Lodging name, applies to all nights. Per-night lodging: set_lodging afterwards." },
        dayStart: { type: "string", description: "HH:MM start for every day. Default 09:00." },
        replace: { type: "boolean", description: "Must be true to overwrite an existing trip." },
      },
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: wrap(async (args) => {
      const p = z
        .object({
          places: z.array(z.string()).optional(),
          days: z.array(z.array(z.string())).optional(),
          dayCount: z.number().int().optional(),
          lodging: z.string().optional(),
          dayStart: z.string().optional(),
          replace: z.boolean().optional(),
        })
        .safeParse(args);
      if (!p.success) return zodErr(p.error);
      return planTrip({ trip, matrix, nominatim }, p.data);
    }),
  };

  const setLegMode: RegisterToolOptions = {
    name: "set_leg_mode",
    description:
      "Set how one leg is travelled: walk, drive or transit. Name the leg by the stop it departs from ([s#] id; 'lodging' for a day's first leg). Legs default to walk under about 1.2 km and drive above — call this only to override. transit fetches live routes (a few seconds) and returns the steps: lines, headsigns, where to get off. If no transit route exists the leg keeps its old mode and the result says so. Pending.",
    inputSchema: {
      type: "object",
      properties: {
        day: { type: "number", minimum: 1, description: "Day 1..N containing the leg." },
        fromStop: { type: "string", description: "[s#] id the leg departs from, or 'lodging' for the day's first leg." },
        mode: { type: "string", enum: ["walk", "drive", "transit"], description: "walk | drive | transit." },
      },
      required: ["day", "fromStop", "mode"],
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: wrap(async (args) => {
      const p = z
        .object({ day: z.number().int(), fromStop: sidArg, mode: z.enum(["walk", "drive", "transit"]) })
        .safeParse(args);
      if (!p.success) return zodErr(p.error);
      const s = state();
      const { day } = p.data;
      const t = legFromStop(s, day, p.data.fromStop);
      if ("error" in t) return err(t.error);
      const toSid = t.toSid;

      if (p.data.mode === "transit") {
        const r = await applyTransitLeg(trip, deps.fetchTransit, "agent", day, toSid);
        if (!r.ok) return r.message;
        const s2 = state();
        const e = lastEditId(s2);
        const steps = transitSteps(r.leg);
        let out = `Leg ${r.target.fromLabel}->[${toSid}] transit ${r.leg.totalMin}m, ${r.leg.transfers} transfer${r.leg.transfers === 1 ? "" : "s"} [pending ${e}]`;
        if (steps) out += `: ${steps}`;
        out += `. ${endsPhrase(s2, day)}.`;
        return out.length > 1500 ? out.slice(0, 1490) + "…" : out;
      }

      trip.actions.setLegOverride(
        "agent",
        legKey(t.fromPid, t.toPid),
        { mode: p.data.mode },
        toSid,
        `leg into [${toSid}] -> ${p.data.mode}`,
      );
      const s2 = state();
      const e = lastEditId(s2);
      const sched = computeDaySchedule(s2, day);
      const leg = sched.stops.find((x) => x.sid === toSid)?.legIn;
      return `Leg ${t.fromLabel}->[${toSid}] ${p.data.mode} ${leg?.approx ? "≈" : ""}${leg?.minutes}m [pending ${e}]; ${endsPhrase(s2, day)}.`;
    }),
  };

  const guide: RegisterToolOptions = {
    name: "get_planning_guide",
    description:
      "Read once before planning or filling a trip: typical minutes to spend at different kinds of places, how many stops make a comfortable day, and when to leave free time for meals. Use it to choose dwellMinutes for add_place and set_times and to decide how much to pack into a day. Static text — the live trip comes from get_itinerary.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute: wrap(() => PLANNING_GUIDE),
  };

  return [...buildReadTools(deps), planTripTool, addPlace, moveStop, setTimes, setLegMode, setLodging, arrangeDays, guide];
}
