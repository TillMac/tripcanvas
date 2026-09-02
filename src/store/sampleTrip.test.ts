import { describe, it, expect } from "vitest";
import { createTripStore } from "./store.js";
import { loadSampleTrip } from "./sampleTrip.js";
import { computeDaySchedule, tripWarnings } from "./schedule.js";
import { renderTrip } from "./handback.js";

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
    expect(s.stops.s8.pending).toBe("e1");
    expect(s.log[s.log.length - 1].summary).toContain("example:");
    // schedules compute (estimates until the matrix arrives) and stay sane
    const d1 = computeDaySchedule(s, 1);
    expect(d1.stops).toHaveLength(4);
    expect(tripWarnings(s).overflowDays).toEqual([]);
    expect(renderTrip(s)).toContain("Senso-ji Temple");
    // Revert on the example edit works like a real one
    const r = t.actions.revert("human", "e1");
    expect("reverted" in r && r.reverted).toEqual(["s8"]);
    expect(t.store.getState().stops.s8).toBeUndefined();
    // undo unwinds back to the empty canvas
    t.actions.undo();
    t.actions.undo();
    expect(t.store.getState().days).toHaveLength(0);
  });
});
