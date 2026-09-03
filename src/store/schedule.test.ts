import { describe, it, expect } from "vitest";
import { createTripStore, type PlaceInput } from "./store.js";
import { computeDaySchedule, tripWarnings } from "./schedule.js";
import { fmtHHMM } from "../ported/schedule-ops.js";

const P = (name: string, lat: number, lon: number): PlaceInput => ({ name, lat, lon, query: name.toLowerCase() });

// Places ~0.9km apart pairwise (walkable) unless spread wider.
function tripWithMatrix() {
  const t = createTripStore();
  t.actions.ensureDays("human", 2);
  t.actions.addResolvedStop("human", P("A", 35.700, 139.700), { day: 1 });
  t.actions.addResolvedStop("human", P("B", 35.708, 139.700), { day: 1, position: 2 });
  t.actions.setLodging("human", P("Hotel", 35.695, 139.700));
  // matrix over p1(A), p2(B), p3(Hotel) — ids sorted: p1, p2, p3
  t.store.setState({
    matrices: {
      ids: ["p1", "p2", "p3"],
      forHash: "p1;p2;p3",
      stale: false,
      walk: [
        [0, 720, 420],
        [720, 0, 900],
        [420, 900, 0],
      ],
      drive: [
        [0, 300, 240],
        [300, 0, 360],
        [240, 360, 0],
      ],
    },
  });
  return t;
}

describe("computeDaySchedule", () => {
  it("clocks lodging -> stops -> lodging with matrix walk times", () => {
    const t = tripWithMatrix();
    const d = computeDaySchedule(t.store.getState(), 1);
    // 09:00 leave hotel, walk 7min (420s) -> A 09:07-10:07, walk 12min -> B 10:19-11:19,
    // back leg B->Hotel ~1.44km => drive 6min (360s)
    expect(fmtHHMM(d.stops[0].arriveMin)).toBe("09:07");
    expect(fmtHHMM(d.stops[0].departMin)).toBe("10:07");
    expect(d.stops[1].legIn?.minutes).toBe(12);
    expect(fmtHHMM(d.stops[1].arriveMin)).toBe("10:19");
    expect(d.backLeg?.mode).toBe("drive");
    expect(d.backLeg?.minutes).toBe(6);
    expect(fmtHHMM(d.endMin)).toBe("11:25");
    expect(d.approx).toBe(false);
    expect(d.overflow).toBe(false);
  });

  it("legs default walk <=1.2km else drive; overrides win; separated pairs fall back silently", () => {
    const t = tripWithMatrix();
    // A->B ~0.9km => walk by default
    let d = computeDaySchedule(t.store.getState(), 1);
    expect(d.stops[1].legIn?.mode).toBe("walk");
    // override the pair to drive
    t.actions.setLegOverride("human", "p1>p2", { mode: "drive" });
    d = computeDaySchedule(t.store.getState(), 1);
    expect(d.stops[1].legIn?.mode).toBe("drive");
    expect(d.stops[1].legIn?.minutes).toBe(5); // 300s
    // separate the pair: move B to day 2 — override becomes inert, no error
    t.actions.moveStop("human", "s2", 2);
    d = computeDaySchedule(t.store.getState(), 1);
    expect(d.stops).toHaveLength(1);
  });

  it("transit override uses the fetched leg's minutes", () => {
    const t = tripWithMatrix();
    t.actions.setLegOverride("human", "p1>p2", {
      mode: "transit",
      transit: { totalMin: 28, transfers: 1, steps: [] },
    });
    const d = computeDaySchedule(t.store.getState(), 1);
    expect(d.stops[1].legIn?.mode).toBe("transit");
    expect(d.stops[1].legIn?.minutes).toBe(28);
    expect(d.stops[1].legIn?.approx).toBe(false);
  });

  it("uncovered pairs use haversine estimates and mark the day approximate", () => {
    const t = tripWithMatrix();
    t.store.setState({ matrices: { ids: [], forHash: "", stale: true } });
    const d = computeDaySchedule(t.store.getState(), 1);
    expect(d.approx).toBe(true);
    expect(d.stops[0].legIn?.approx).toBe(true);
    expect(d.stops[0].legIn?.minutes).toBeGreaterThan(0);
  });

  it("a covered pair keeps its real time while the set is stale; only uncovered legs are ≈", () => {
    const t = tripWithMatrix();
    t.store.setState({ matrices: { ...t.store.getState().matrices, stale: true } });
    const d = computeDaySchedule(t.store.getState(), 1);
    expect(d.stops[1].legIn?.approx).toBe(false);
    expect(d.approx).toBe(false);
  });

  it("free time at day start and after stops shifts the clock", () => {
    const t = tripWithMatrix();
    t.actions.setDayFreeStart("human", 1, 30);
    t.actions.setFreeAfter("human", "s1", 45);
    const d = computeDaySchedule(t.store.getState(), 1);
    // 09:00 +30 free, walk 7 -> A 09:37-10:37, +45 free, walk 12 -> B 11:34
    expect(fmtHHMM(d.stops[0].arriveMin)).toBe("09:37");
    expect(fmtHHMM(d.stops[1].arriveMin)).toBe("11:34");
  });

  it("last day ends at its final stop when the toggle is off", () => {
    const t = tripWithMatrix();
    t.actions.moveStop("human", "s2", 2);
    let d2 = computeDaySchedule(t.store.getState(), 2);
    expect(d2.backLeg).not.toBeNull(); // default: return to lodging
    const endWithBack = d2.endMin;
    t.actions.setEndLastDayAtLodging("human", false);
    d2 = computeDaySchedule(t.store.getState(), 2);
    expect(d2.backLeg).toBeNull();
    expect(d2.endMin).toBeLessThan(endWithBack);
  });

  it("day with no lodging starts at its first stop (no leg in)", () => {
    const t = createTripStore();
    t.actions.ensureDays("human", 1);
    t.actions.addResolvedStop("human", P("A", 35.7, 139.7), { day: 1 });
    const d = computeDaySchedule(t.store.getState(), 1);
    expect(d.stops[0].legIn).toBeNull();
    expect(fmtHHMM(d.stops[0].arriveMin)).toBe("09:00");
    expect(d.backLeg).toBeNull();
  });

  it("overflow past 22:00 and long legs are flagged", () => {
    const t = createTripStore();
    t.actions.ensureDays("human", 1);
    t.actions.addResolvedStop("human", P("A", 35.70, 139.70), { day: 1, dwellMin: 60 });
    t.actions.addResolvedStop("human", P("Far", 36.20, 139.70), { day: 1, position: 2, dwellMin: 600 });
    t.actions.setDayStart("human", 1, "12:00");
    const w = tripWarnings(t.store.getState());
    expect(w.overflowDays).toEqual([1]);
    expect(w.longLegCount).toBeGreaterThan(0);
  });
});
