import { describe, it, expect } from "vitest";
import { createTripStore } from "./store.js";
import { loadSampleTrip } from "./sampleTrip.js";
import { computeDaySchedule, tripWarnings } from "./schedule.js";
import { renderTrip } from "./handback.js";
import { pendingEdits } from "./store.js";

describe("loadSampleTrip", () => {
  it("loads a 3-day, 10-stop trip with lodging and candidates as ONE undoable human commit", () => {
    const t = createTripStore();
    loadSampleTrip(t);
    const s = t.store.getState();
    expect(s.rev).toBe(2); // load commit + the labelled example pending edit
    expect(s.days).toHaveLength(3);
    expect(s.days.flatMap((d) => d.stops)).toHaveLength(10);
    expect(s.candidates).toEqual(["c1", "c2"]);
    expect(s.nights.every((n) => n === "p1")).toBe(true);
    // one clearly-labelled example pending edit shows the review loop
    expect(s.stops.s4.pending).toBe("e1"); // on Day 1, visible on first paint
    expect(s.log[s.log.length - 1].summary).toContain("example:");
    // schedules compute (estimates until the matrix arrives) and stay sane
    const d1 = computeDaySchedule(s, 1);
    expect(d1.stops).toHaveLength(4);
    expect(tripWarnings(s).overflowDays).toEqual([]);
    expect(renderTrip(s)).toContain("Senso-ji Temple");
    // Revert on the example edit works like a real one
    const r = t.actions.revert("human", "e1");
    expect("reverted" in r && r.reverted).toEqual(["s4"]);
    expect(t.store.getState().stops.s4).toBeUndefined();
    // undo of the Revert puts the example stop back (its ops are real, not a bare mark)
    t.actions.undo();
    expect(t.store.getState().days[0].stops).toContain("s4");
    expect(t.store.getState().stops.s4.pending).toBe("e1");
    // two more undos (example edit, load) unwind to the empty canvas
    t.actions.undo();
    t.actions.undo();
    expect(t.store.getState().days).toHaveLength(0);
  });

  it("exampleEdit:false loads the trip with no fake agent edit (a real agent is connected)", () => {
    const t = createTripStore();
    loadSampleTrip(t, { exampleEdit: false });
    const s = t.store.getState();
    expect(s.rev).toBe(1);
    expect(pendingEdits(s)).toHaveLength(0);
    expect(s.log.some((e) => e.actor === "agent")).toBe(false);
  });

  it("takes the example edit id from the live counter, so a reverted e1 left in the persisted log cannot swallow it", () => {
    const t = createTripStore();
    const P = { places: { p1: { id: "p1", name: "A", lat: 1, lon: 1, query: "a" } }, stops: { s1: { place: "p1", dwellMin: 60, freeAfterMin: 0 } }, days: [{ start: "09:00", stops: ["s1"] }], nights: [null], candidates: [] };
    t.actions.planCommit("agent", P, "planned"); // e1
    t.actions.revert("human", "e1"); // trip empties, e1 stays in the log as reverted
    loadSampleTrip(t);
    const s = t.store.getState();
    const eid = s.stops.s4.pending!;
    expect(eid).toBe("e2");
    expect(pendingEdits(s).map((p) => p.editId)).toEqual([eid]);
    expect("reverted" in t.actions.revert("human", eid)).toBe(true);
  });
});
