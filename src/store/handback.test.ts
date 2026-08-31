import { describe, it, expect } from "vitest";
import { createTripStore, type PlaceInput } from "./store.js";
import { renderTrip, renderDayOneLiner } from "./handback.js";

const P = (name: string, lat: number, lon: number): PlaceInput => ({ name, lat, lon, query: name.toLowerCase() });

function fixtureTrip() {
  const t = createTripStore();
  t.actions.ensureDays("human", 2);
  t.actions.addResolvedStop("human", P("Senso-ji", 35.700, 139.700), { day: 1 });
  t.actions.addResolvedStop("human", P("Ueno Park", 35.708, 139.700), { day: 1, position: 2 });
  t.actions.addResolvedStop("human", P("Shibuya", 35.658, 139.701), { day: 2 });
  t.actions.addResolvedStop("human", P("Ghibli Museum", 35.696, 139.570), {});
  t.actions.setLodging("human", P("Hotel Gracery", 35.695, 139.700));
  const N = 5;
  const table = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => (i === j ? 0 : 600)),
  );
  t.store.setState({
    matrices: { ids: ["p1", "p2", "p3", "p4", "p5"], forHash: "ignored", stale: false, walk: table, drive: table },
  });
  return t;
}

describe("renderTrip", () => {
  it("empty trip renders the guidance line", () => {
    const t = createTripStore();
    expect(renderTrip(t.store.getState())).toBe("Trip is empty — use plan_trip or add_place.");
  });

  it("header counts days/stops/candidates, lodging, last-day mode", () => {
    const t = fixtureTrip();
    const out = renderTrip(t.store.getState());
    expect(out).toContain("2 days, 3 stops, 1 candidate.");
    expect(out).toContain("Lodging all nights: Hotel Gracery.");
    expect(out).toContain("Last day ends at lodging.");
    expect(out.startsWith(`TRIP rev${t.store.getState().rev}`)).toBe(true);
  });

  it("stop lines follow the grammar: id, name, times, dwell, arriving leg", () => {
    const t = fixtureTrip();
    const out = renderTrip(t.store.getState());
    expect(out).toMatch(/\[s1\] Senso-ji \d\d:\d\d-\d\d:\d\d d60 \|walk≈?\d+\|/);
    expect(out).toMatch(/back \w+≈?\d+ — ends \d\d:\d\d/);
    expect(out).toContain("DAY 1 09:00 from lodging");
    expect(out).toContain("Candidates: [c1] Ghibli Museum");
  });

  it("pending agent edits star the name (stop op) or the leg (leg op)", () => {
    const t = fixtureTrip();
    t.actions.addResolvedStop("agent", P("Meiji Shrine", 35.676, 139.699), { day: 2, position: 1 });
    const s1 = t.store.getState();
    const out = renderTrip(s1);
    expect(out).toContain("Marks: * = your pending edit");
    expect(out).toMatch(/Meiji Shrine\* /);
    // leg override pending: star sits inside the leg token
    const key = `${s1.stops.s1.place}>${s1.stops.s2.place}`; // the leg INTO [s2] on day 1
    t.actions.setLegOverride("agent", key, { mode: "drive" }, "s2", "leg into [s2] -> drive");
    const out2 = renderTrip(t.store.getState());
    expect(out2).toMatch(/\|drive≈?\d+\*\|/);
  });

  it("free time blocks render between stops", () => {
    const t = fixtureTrip();
    t.actions.setFreeAfter("human", "s1", 45);
    const out = renderTrip(t.store.getState());
    expect(out).toMatch(/free \d\d:\d\d-\d\d:\d\d \(45m\)/);
  });

  it("single-day and compact variants", () => {
    const t = fixtureTrip();
    const one = renderTrip(t.store.getState(), { day: 2 });
    expect(one).toContain("DAY 2");
    expect(one).not.toContain("DAY 1");
    const compact = renderTrip(t.store.getState(), { compact: true });
    expect(compact).toContain("Pass day:N for stop detail");
    expect(compact).toContain(renderDayOneLiner(t.store.getState(), 1));
  });

  it("warnings line reports none in the quiet case", () => {
    const t = fixtureTrip();
    expect(renderTrip(t.store.getState())).toContain("Warnings: none");
  });
});
