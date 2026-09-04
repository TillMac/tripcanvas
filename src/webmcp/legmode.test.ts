// set_leg_mode seam tests (T9): fromStop [s#] or 'lodging', transit steps in
// the result, pair-keyed override in the store, pending on the arriving stop
// (or on the departing last stop for the return to lodging).
import { describe, it, expect } from "vitest";
import { buildTools, type ToolDeps } from "./tools.js";
import { createTripStore, type PlaceInput } from "../store/store.js";
import type { TransitLeg } from "../ported/motis.js";
import { computeDaySchedule } from "../store/schedule.js";

const P = (name: string, lat: number, lon: number): PlaceInput => ({ name, lat, lon, query: name.toLowerCase() });

const LEG: TransitLeg = {
  totalMin: 28,
  transfers: 1,
  steps: [
    { mode: "walk", line: null, color: null, headsign: null, durationMin: 4, fromName: "A", toName: "Ueno Sta", coords: [] },
    { mode: "transit", line: "Ginza Line", color: "f62e36", headsign: "Shibuya", durationMin: 18, fromName: "Ueno Sta", toName: "Tawaramachi", coords: [[35.71, 139.79]] },
    { mode: "walk", line: null, color: null, headsign: null, durationMin: 6, fromName: "Tawaramachi", toName: "B", coords: [] },
  ],
};

function fakeDeps(transit: () => Promise<TransitLeg | null>) {
  const trip = createTripStore();
  const deps: ToolDeps = {
    trip,
    matrix: { ensureFresh: async () => {} },
    fetchTransit: transit,
    nominatim: { resolve: async () => ({ ok: false, kind: "error", message: "unused" }) },
  };
  const tools = Object.fromEntries(buildTools(deps).map((t) => [t.name, t]));
  trip.actions.ensureDays("human", 2);
  trip.actions.addResolvedStop("human", P("A", 35.71, 139.79), { day: 1 });
  trip.actions.addResolvedStop("human", P("B", 35.712, 139.771), { day: 1, position: 2 });
  trip.actions.setLodging("human", P("Hotel", 35.70, 139.78));
  return { trip, tools };
}

describe("set_leg_mode", () => {
  it("transit returns steps and stores the override pending", async () => {
    const { trip, tools } = fakeDeps(async () => LEG);
    const out = (await tools.set_leg_mode.execute({ day: 1, fromStop: "s1", mode: "transit" })) as string;
    expect(out).toMatch(/^Leg \[s1\]->\[s2\] transit 28m, 1 transfer \[pending e1\]: walk 4m to Ueno Sta; Ginza Line toward Shibuya, off at Tawaramachi; walk 6m to B\. D1 ends \d\d:\d\d\.$/);
    const s = trip.store.getState();
    const key = `${s.stops.s1.place}>${s.stops.s2.place}`;
    expect(s.legOverrides[key]?.transit?.totalMin).toBe(28);
    expect(s.stops.s2.pending).toBe("e1");
    expect(tools.set_leg_mode.annotations?.untrustedContentHint).toBe(true);
  });

  it("'lodging' names the day's first leg", async () => {
    const { trip, tools } = fakeDeps(async () => LEG);
    const out = (await tools.set_leg_mode.execute({ day: 1, fromStop: "lodging", mode: "drive" })) as string;
    expect(out).toMatch(/^Leg lodging->\[s1\] drive ≈?\d+m \[pending e1\]; D1 ends \d\d:\d\d\.$/);
    const s = trip.store.getState();
    const key = `${s.nights[0]}>${s.stops.s1.place}`;
    expect(s.legOverrides[key]?.mode).toBe("drive");
  });

  it("no transit route / service down keep the old mode", async () => {
    const a = fakeDeps(async () => null);
    expect(await a.tools.set_leg_mode.execute({ day: 1, fromStop: "s1", mode: "transit" })).toMatch(
      /^ERROR: no transit route found — leg stays \w+ \(\d+m\)\.$/,
    );
    expect(a.trip.store.getState().legOverrides).toEqual({});
    const b = fakeDeps(async () => { throw new Error("down"); });
    expect(await b.tools.set_leg_mode.execute({ day: 1, fromStop: "s1", mode: "transit" })).toBe(
      "ERROR: transit service unreachable — mode unchanged, try again.",
    );
  });

  it("the last stop names the return leg to lodging, marked on that stop", async () => {
    const { trip, tools } = fakeDeps(async () => LEG);
    const out = (await tools.set_leg_mode.execute({ day: 1, fromStop: "s2", mode: "transit" })) as string;
    expect(out).toMatch(/^Leg \[s2\]->lodging transit 28m, 1 transfer \[pending e1\]/);
    const s = trip.store.getState();
    const hotel = s.nights[0]!;
    expect(s.legOverrides[`${s.stops.s2.place}>${hotel}`]?.mode).toBe("transit");
    expect(s.stops.s2.pending).toBe("e1");
    expect(computeDaySchedule(s, 1).backLeg?.mode).toBe("transit");
    // the handback stars the return leg, not the unchanged arriving leg
    expect((await tools.get_itinerary.execute({ day: 1 })) as string).toMatch(/\[s2\] B [^\n]*\|drive≈4\| back transit28\*/);
    // drive on the return leg, no fetch involved
    expect(await tools.set_leg_mode.execute({ day: 1, fromStop: "s2", mode: "drive" })).toMatch(/^Leg \[s2\]->lodging drive/);
  });

  it("unknown-stop and day errors match the design; a day with no lodging has no return leg", async () => {
    const { trip, tools } = fakeDeps(async () => LEG);
    expect(await tools.set_leg_mode.execute({ day: 1, fromStop: "s9", mode: "walk" })).toBe(
      "ERROR: no stop [s9] on day 1 — ids come from get_itinerary.",
    );
    expect(await tools.set_leg_mode.execute({ day: 5, fromStop: "s1", mode: "walk" })).toBe(
      "ERROR: day 5 out of range (trip has 2).",
    );
    // last day ending at its final stop: the last stop has no return leg to name
    trip.actions.moveStop("human", "s2", 2);
    trip.actions.setEndLastDayAtLodging("human", false);
    expect(await tools.set_leg_mode.execute({ day: 2, fromStop: "s2", mode: "drive" })).toBe(
      "ERROR: day 2 ends at [s2] — no lodging to return to.",
    );
  });

  it("separated pairs silently fall back (override inert, no error)", async () => {
    const { trip, tools } = fakeDeps(async () => LEG);
    await tools.set_leg_mode.execute({ day: 1, fromStop: "s1", mode: "transit" });
    trip.actions.moveStop("human", "s2", 2); // separates the pair (and implicit-accepts)
    // schedule still computes; no transit on the remaining day-1 stop
    const out = (await tools.get_itinerary.execute({ day: 1 })) as string;
    expect(out).not.toContain("transit 28");
  });
});
