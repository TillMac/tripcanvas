// plan_trip seam tests: scripted resolver, fake matrix, real store.
import { describe, it, expect } from "vitest";
import { buildTools, type ToolDeps } from "./tools.js";
import { createTripStore } from "../store/store.js";
import type { ResolveResult } from "../store/nominatim.js";
import type { PlaceCandidate } from "../ported/place-assert.js";

// Two clusters: north (senso-ji, ueno, akihabara) and west (ghibli, inokashira)
const PLACES: Record<string, PlaceCandidate & { cachedFlag?: boolean }> = {
  "senso-ji": { placeId: "1", name: "Senso-ji", lat: 35.714, lng: 139.796, city: "Taito", cachedFlag: true },
  "ueno park": { placeId: "2", name: "Ueno Park", lat: 35.712, lng: 139.771 },
  "akihabara": { placeId: "3", name: "Akihabara", lat: 35.702, lng: 139.774 },
  "ghibli museum": { placeId: "4", name: "Ghibli Museum", lat: 35.696, lng: 139.570 },
  "inokashira park": { placeId: "5", name: "Inokashira Park", lat: 35.700, lng: 139.573 },
  "hotel gracery": { placeId: "6", name: "Hotel Gracery", lat: 35.695, lng: 139.700, city: "Shinjuku" },
};

function fakeDeps(opts: { failAfter?: number } = {}) {
  const trip = createTripStore();
  let resolveCalls = 0;
  const deadlines: (number | undefined)[] = [];
  const pinSnapshots: number[] = [];
  const origSetPins = trip.actions.setResolvingPins.bind(trip.actions);
  trip.actions.setResolvingPins = (pins) => {
    pinSnapshots.push(pins.length);
    origSetPins(pins);
  };
  const deps: ToolDeps = {
    trip,
    matrix: { ensureFresh: async () => {} },
    fetchTransit: async () => null,
    nominatim: {
      resolve: async (q, o): Promise<ResolveResult> => {
        deadlines.push(o?.deadline);
        resolveCalls += 1;
        if (opts.failAfter !== undefined && resolveCalls > opts.failAfter) {
          return { ok: false, kind: "deadline", message: `not resolved (time limit): '${q}'` };
        }
        const place = PLACES[q.trim().toLowerCase()];
        if (!place) return { ok: false, kind: "none", message: `no place found for '${q}'` };
        return { ok: true, place, cached: !!place.cachedFlag };
      },
    },
  };
  const tools = Object.fromEntries(buildTools(deps).map((t) => [t.name, t]));
  return { trip, tools, deadlines, pinSnapshots };
}

const FIVE = ["Senso-ji", "Ueno Park", "Akihabara", "Ghibli Museum", "Inokashira Park"];

describe("plan_trip", () => {
  it("plans days from flat places + dayCount as ONE pending batch; pins drop and clear", async () => {
    const { trip, tools, deadlines, pinSnapshots } = fakeDeps();
    const out = (await tools.plan_trip.execute({ places: FIVE, dayCount: 2, lodging: "Hotel Gracery" })) as string;
    expect(out).toMatch(/^Planned 2 days, 5 stops \(4 fresh, 1 cached\) — all pending as e1; the human is reviewing on the map\./);
    expect(out).toMatch(/D1 09:00-\d\d:\d\d: /);
    expect(out).toMatch(/D2 09:00-\d\d:\d\d: /);
    expect(out).toContain("Warnings:");
    expect(out.length).toBeLessThanOrEqual(1500);
    const s = trip.store.getState();
    expect(s.days).toHaveLength(2);
    const placed = s.days.flatMap((d) => d.stops);
    expect(placed).toHaveLength(5);
    expect(placed.every((sid) => s.stops[sid].pending === "e1")).toBe(true);
    expect(s.nights.every((n) => n && s.places[n].name === "Hotel Gracery")).toBe(true);
    expect(s.resolvingPins).toEqual([]);
    expect(pinSnapshots.length).toBeGreaterThan(2); // pins dropped progressively
    expect(deadlines.every((d) => d !== undefined)).toBe(true);
    // rev = 1: ONE atomic commit
    expect(s.rev).toBe(1);
    // clusters: the two west places share a day
    const names = s.days.map((d) => d.stops.map((sid) => s.places[s.stops[sid].place].name).sort().join(","));
    expect(names).toContain("Ghibli Museum,Inokashira Park");
  });

  it("honours pre-grouped days verbatim (each day still ordered)", async () => {
    const { trip, tools } = fakeDeps();
    const out = (await tools.plan_trip.execute({
      days: [["Senso-ji", "Ghibli Museum"], ["Ueno Park", "Akihabara"]],
      lodging: "Hotel Gracery",
    })) as string;
    expect(out).toContain("Planned 2 days, 4 stops");
    const s = trip.store.getState();
    const names = s.days.map((d) => d.stops.map((sid) => s.places[s.stops[sid].place].name).sort().join(","));
    expect(names[0]).toBe("Ghibli Museum,Senso-ji"); // grouping kept even though clusters differ
    expect(names[1]).toBe("Akihabara,Ueno Park");
  });

  it("cap, replace guard, and validation errors match the design", async () => {
    const { trip, tools } = fakeDeps();
    const thirteen = Array.from({ length: 13 }, (_, i) => `Place ${i}`);
    expect(await tools.plan_trip.execute({ places: thirteen, dayCount: 3 })).toMatch(
      /^ERROR: 13 names exceeds the 12-per-call cap/,
    );
    expect(await tools.plan_trip.execute({ places: FIVE })).toBe("ERROR: dayCount is required with places (1-7).");
    expect(await tools.plan_trip.execute({})).toBe("ERROR: give places with dayCount, or days.");
    // build a trip, then try to overwrite without replace
    await tools.plan_trip.execute({ places: FIVE, dayCount: 2 });
    const rev = trip.store.getState().rev;
    expect(await tools.plan_trip.execute({ places: FIVE, dayCount: 3 })).toBe(
      `ERROR: a trip exists (rev ${rev}) — pass replace:true or edit it instead.`,
    );
    // replace:true works and is one revert away
    const out = (await tools.plan_trip.execute({ places: FIVE.slice(0, 3), dayCount: 1, replace: true })) as string;
    expect(out).toContain("Planned 1 days, 3 stops");
    const r = trip.actions.revert("agent", trip.store.getState().log[trip.store.getState().log.length - 1].editId!);
    expect("reverted" in r).toBe(true);
    expect(trip.store.getState().days).toHaveLength(2); // old trip restored
  });

  it("unresolved names are listed, never fatal; under 2 resolved leaves the trip unchanged", async () => {
    const { trip, tools } = fakeDeps();
    const out = (await tools.plan_trip.execute({
      places: ["Senso-ji", "Ueno Park", "Fantasy Spot"],
      dayCount: 1,
    })) as string;
    expect(out).toContain("Planned 1 days, 2 stops");
    expect(out).toMatch(/Unresolved \(not added\): 'Fantasy Spot' — retry a fuller name via add_place\./);

    const t2 = fakeDeps();
    const out2 = (await t2.tools.plan_trip.execute({ places: ["Fantasy Spot", "Nowhere"], dayCount: 1 })) as string;
    expect(out2).toBe("ERROR: only 0 names resolved — trip unchanged.");
    expect(t2.trip.store.getState().rev).toBe(0);
    expect(t2.trip.store.getState().resolvingPins).toEqual([]);
  });

  it("deadline breach plans what resolved and lists the rest as time-limited", async () => {
    const { trip, tools } = fakeDeps({ failAfter: 3 });
    const out = (await tools.plan_trip.execute({ places: FIVE, dayCount: 2 })) as string;
    expect(out).toContain("Planned 2 days, 3 stops");
    expect(out).toMatch(/Unresolved \(not added\): 'Ghibli Museum' \(time limit\), 'Inokashira Park' \(time limit\)/);
    expect(trip.store.getState().days.flatMap((d) => d.stops)).toHaveLength(3);
  });

  it("no lodging: days start at their first stop and the result says so", async () => {
    const { tools } = fakeDeps();
    const out = (await tools.plan_trip.execute({ places: FIVE.slice(0, 3), dayCount: 1 })) as string;
    expect(out).toContain("No lodging set — set_lodging to anchor days.");
  });
});
