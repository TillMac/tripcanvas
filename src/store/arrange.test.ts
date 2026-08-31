import { describe, it, expect } from "vitest";
import { createTripStore, type PlaceInput } from "./store.js";
import { arrangeTrip, runArrange } from "./arrange.js";

const P = (name: string, lat: number, lon: number): PlaceInput => ({ name, lat, lon, query: name.toLowerCase() });

// Two geographic clusters ~20km apart; lodging near cluster A.
function clusteredTrip() {
  const t = createTripStore();
  t.actions.ensureDays("human", 2);
  // cluster A (north)
  t.actions.addResolvedStop("human", P("A1", 35.90, 139.70), { day: 1 });
  t.actions.addResolvedStop("human", P("A2", 35.91, 139.70), { day: 2 });
  t.actions.addResolvedStop("human", P("A3", 35.92, 139.70), { day: 1, position: 2 });
  // cluster B (south)
  t.actions.addResolvedStop("human", P("B1", 35.60, 139.70), { day: 1, position: 3 });
  t.actions.addResolvedStop("human", P("B2", 35.61, 139.70), { day: 2, position: 2 });
  t.actions.setLodging("human", P("Hotel", 35.895, 139.70));
  return t;
}

describe("arrangeTrip", () => {
  it("clusters stops into geographic days, deterministically", () => {
    const t = clusteredTrip();
    const r1 = arrangeTrip(t.store.getState());
    const r2 = arrangeTrip(t.store.getState());
    expect(r1).toEqual(r2);
    if ("error" in r1) throw new Error(r1.error);
    const byDay = r1.days.map((d) => d.stops.map((sid) => t.store.getState().places[t.store.getState().stops[sid].place].name).sort());
    // one day holds the A cluster, the other the B cluster
    const flat = byDay.map((g) => g.join(","));
    expect(flat).toContain("B1,B2");
    expect(flat).toContain("A1,A2,A3");
    expect(r1.overflow).toEqual([]);
  });

  it("orders each day from the night's lodging by travel time", () => {
    const t = clusteredTrip();
    const r = arrangeTrip(t.store.getState());
    if ("error" in r) throw new Error(r.error);
    const s = t.store.getState();
    const aDay = r.days.find((d) => d.stops.length === 3)!;
    const names = aDay.stops.map((sid) => s.places[s.stops[sid].place].name);
    // From Hotel (35.895) going north: A1 (35.90), A2 (35.91), A3 (35.92)
    expect(names).toEqual(["A1", "A2", "A3"]);
  });

  it("caps a day at 5 stops; extras become candidates", () => {
    const t = createTripStore();
    t.actions.ensureDays("human", 1);
    for (let i = 0; i < 7; i++) {
      t.actions.addResolvedStop("human", P(`S${i}`, 35.70 + i * 0.001, 139.70), { day: 1, position: i + 1 });
    }
    const r = arrangeTrip(t.store.getState(), 1);
    if ("error" in r) throw new Error(r.error);
    expect(r.days[0].stops).toHaveLength(5);
    expect(r.overflow).toHaveLength(2);
    expect(r.candidates).toHaveLength(2);
  });

  it("grows or shrinks to dayCount; candidates untouched", () => {
    const t = clusteredTrip();
    t.actions.addResolvedStop("human", P("Parked", 35.7, 139.8), {});
    const r = arrangeTrip(t.store.getState(), 3);
    if ("error" in r) throw new Error(r.error);
    expect(r.days).toHaveLength(3);
    expect(r.candidates).toContain("c1");
    expect(r.nights).toHaveLength(3);
    expect(r.nights[2]).toBe(r.nights[0]); // padded with the known lodging
  });

  it("fewer than 2 stops errors", () => {
    const t = createTripStore();
    t.actions.ensureDays("human", 1);
    expect(arrangeTrip(t.store.getState())).toHaveProperty("error");
  });
});

describe("runArrange", () => {
  it("applies as ONE undoable commit through the store", async () => {
    const t = clusteredTrip();
    const before = t.store.getState();
    const r = await runArrange(t, null, "human");
    expect("error" in r).toBe(false);
    const after = t.store.getState();
    expect(after.rev).toBe(before.rev + 1);
    // one Ctrl+Z restores the old assignment entirely
    t.actions.undo();
    expect(t.store.getState().days.map((d) => d.stops)).toEqual(before.days.map((d) => d.stops));
  });

  it("agent arrange lands pending on every placed stop, one-click revert", async () => {
    const t = clusteredTrip();
    const r = await runArrange(t, null, "agent");
    if ("error" in r) throw new Error("unexpected");
    const s = t.store.getState();
    const placed = s.days.flatMap((d) => d.stops);
    expect(placed.every((sid) => s.stops[sid].pending === "e1")).toBe(true);
    const rev = t.actions.revert("agent", "e1");
    expect("reverted" in rev).toBe(true);
  });
});
