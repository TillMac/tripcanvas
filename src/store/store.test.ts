// Store-seam suite (spec: Testing Decisions, secondary seam): dispatch the same
// exported actions as the human/agent and assert external behavior — pending
// marks, implicit accept, undo across actors, revert conflicts, id stability.
import { describe, it, expect } from "vitest";
import { createTripStore, editStatus, pendingEdits, placedHash, type PlaceInput } from "./store.js";

const P = (name: string, lat = 35.7, lon = 139.7): PlaceInput => ({ name, lat, lon, query: name.toLowerCase() });

function threeDayTrip() {
  const t = createTripStore();
  t.actions.ensureDays("human", 3);
  return t;
}

describe("ids and placement", () => {
  it("stops get s# ids on days, c# ids as candidates", () => {
    const t = threeDayTrip();
    const a = t.actions.addResolvedStop("human", P("Senso-ji"), { day: 1 });
    const b = t.actions.addResolvedStop("human", P("Ghibli Museum"), {});
    expect(a.sid).toBe("s1");
    expect(b.sid).toBe("c1");
    expect(t.store.getState().days[0].stops).toEqual(["s1"]);
    expect(t.store.getState().candidates).toEqual(["c1"]);
  });

  it("unassigning to day 0 renames s# -> c#; the old id still resolves", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("human", P("Senso-ji"), { day: 1 });
    const r = t.actions.moveStop("human", "s1", 0);
    expect("sid" in r && r.sid).toBe("c1");
    const s = t.store.getState();
    expect(s.candidates).toEqual(["c1"]);
    expect(s.days[0].stops).toEqual([]);
    // stale reference resolves through the alias
    const r2 = t.actions.setDwell("human", "s1", 90);
    expect("sid" in r2 && r2.sid).toBe("c1");
    expect(s.stops.c1.place).toBeDefined();
  });

  it("placing a candidate on a day renames c# -> s#", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("human", P("Ghibli Museum"), {});
    const r = t.actions.moveStop("human", "c1", 2, 1);
    expect("sid" in r && r.sid).toBe("s1");
    expect(t.store.getState().days[1].stops).toEqual(["s1"]);
  });

  it("move within a day reorders by position", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("human", P("A", 35.70, 139.70), { day: 1 });
    t.actions.addResolvedStop("human", P("B", 35.71, 139.71), { day: 1, position: 2 });
    t.actions.addResolvedStop("human", P("C", 35.72, 139.72), { day: 1, position: 3 });
    t.actions.moveStop("human", "s3", 1, 1);
    expect(t.store.getState().days[0].stops).toEqual(["s3", "s1", "s2"]);
  });

  it("unknown id and out-of-range day return errors", () => {
    const t = threeDayTrip();
    expect(t.actions.moveStop("human", "s99", 1)).toHaveProperty("error");
    t.actions.addResolvedStop("human", P("A"), { day: 1 });
    expect(t.actions.moveStop("human", "s1", 6)).toHaveProperty("error");
  });
});

describe("pending model (ADR-0004)", () => {
  it("agent commits get editIds and pending marks; human commits do not", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("human", P("A"), { day: 1 });
    t.actions.addResolvedStop("agent", P("B"), { day: 1 });
    const s = t.store.getState();
    expect(s.stops.s1.pending).toBeUndefined();
    expect(s.stops.s2.pending).toBe("e1");
    expect(pendingEdits(s).map((p) => p.editId)).toEqual(["e1"]);
  });

  it("human edit of a pending stop implicitly accepts it, logged", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("agent", P("B"), { day: 1 });
    t.actions.setDwell("human", "s1", 45);
    const s = t.store.getState();
    expect(s.stops.s1.pending).toBeUndefined();
    expect(s.stops.s1.dwellMin).toBe(45);
    const acceptEntry = s.log.find((e) => e.op === "accept");
    expect(acceptEntry?.summary).toContain("accepted your e1");
    expect(editStatus(s, "e1")?.fate).toBe("accepted");
  });

  it("accept(editId) clears marks; acceptAll clears everything", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("agent", P("B"), { day: 1 });
    t.actions.addResolvedStop("agent", P("C"), { day: 2 });
    const r = t.actions.accept("e1");
    expect("accepted" in r && r.accepted).toEqual(["s1"]);
    expect(t.store.getState().stops.s1.pending).toBeUndefined();
    expect(t.store.getState().stops.s2.pending).toBe("e2");
    const all = t.actions.acceptAll();
    expect(all.edits).toEqual(["e2"]);
    expect(pendingEdits(t.store.getState())).toHaveLength(0);
  });

  it("revert removes a still-pending add entirely", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("agent", P("B"), { day: 1 });
    const r = t.actions.revert("agent", "e1");
    expect("reverted" in r && r.reverted).toEqual(["s1"]);
    const s = t.store.getState();
    expect(s.days[0].stops).toEqual([]);
    expect(s.stops.s1).toBeUndefined();
    expect(editStatus(s, "e1")?.fate).toBe("reverted");
  });

  it("revert of a fully accepted edit errors and changes nothing", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("agent", P("B"), { day: 1 });
    t.actions.accept("e1");
    const r = t.actions.revert("agent", "e1");
    expect("error" in r && r.error).toContain("fully accepted");
    expect(t.store.getState().days[0].stops).toEqual(["s1"]);
  });

  it("partial batch: human-touched member stays, rest reverted (plan-style group)", () => {
    const t = threeDayTrip();
    // agent batch adds two stops as one group (planCommit path)
    const s0 = t.store.getState();
    t.actions.planCommit(
      "agent",
      {
        places: {
          p1: { id: "p1", name: "A", lat: 35.7, lon: 139.7, query: "a" },
          p2: { id: "p2", name: "B", lat: 35.71, lon: 139.71, query: "b" },
        },
        stops: {
          s1: { place: "p1", dwellMin: 60, freeAfterMin: 0 },
          s2: { place: "p2", dwellMin: 60, freeAfterMin: 0 },
        },
        days: [
          { start: "09:00", stops: ["s1", "s2"] },
          ...s0.days.slice(1),
        ],
        nights: s0.nights,
        candidates: [],
      },
      "planned 1 day, 2 stops",
    );
    // human touches s1 -> implicit accept of that member
    t.actions.setDwell("human", "s1", 90);
    const st = editStatus(t.store.getState(), "e1");
    expect(st?.fate).toBe("partial");
    const r = t.actions.revert("agent", "e1");
    expect("kept" in r && r.kept).toEqual(["s1"]);
    const s = t.store.getState();
    // ponytail: group inverse is a whole-trip snapshot, so partial revert of a
    // plan batch keeps accepted stops by re-checking marks, not surgery
    expect(s.stops.s1).toBeDefined();
  });
});

describe("undo across actors", () => {
  it("Ctrl+Z undoes the last thing that happened regardless of actor", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("human", P("A"), { day: 1 });
    t.actions.addResolvedStop("agent", P("B"), { day: 1 });
    expect(t.store.getState().days[0].stops).toHaveLength(2);
    t.actions.undo(); // undoes the agent add
    let s = t.store.getState();
    expect(s.days[0].stops).toEqual(["s1"]);
    expect(s.stops.s2).toBeUndefined();
    t.actions.undo(); // undoes the human add
    s = t.store.getState();
    expect(s.days[0].stops).toEqual([]);
    t.actions.undo(); // undoes ensureDays
    expect(t.actions.undo()).toHaveProperty("error");
  });

  it("undo of a move restores the previous position and id", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("human", P("A"), { day: 1 });
    t.actions.moveStop("human", "s1", 0);
    t.actions.undo();
    const s = t.store.getState();
    expect(s.days[0].stops).toEqual(["s1"]);
    expect(s.candidates).toEqual([]);
    expect(s.stops.s1).toBeDefined();
  });

  it("rev grows monotonically through undo", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("human", P("A"), { day: 1 });
    const before = t.store.getState().rev;
    t.actions.undo();
    expect(t.store.getState().rev).toBe(before + 1);
  });
});

describe("timing knobs and lodging", () => {
  it("setDayStart / setFreeAfter / setDayFreeStart round-trip with undo", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("human", P("A"), { day: 1 });
    t.actions.setDayStart("human", 1, "10:30");
    t.actions.setFreeAfter("human", "s1", 45);
    t.actions.setDayFreeStart("human", 1, 30);
    let s = t.store.getState();
    expect(s.days[0].start).toBe("10:30");
    expect(s.stops.s1.freeAfterMin).toBe(45);
    expect(s.days[0].freeStartMin).toBe(30);
    t.actions.undo();
    t.actions.undo();
    t.actions.undo();
    s = t.store.getState();
    expect(s.days[0].start).toBe("09:00");
    expect(s.stops.s1.freeAfterMin).toBe(0);
    expect(s.days[0].freeStartMin ?? 0).toBe(0);
  });

  it("setLodging anchors all nights by default, single nights on request", () => {
    const t = threeDayTrip();
    const r = t.actions.setLodging("human", P("Hotel Gracery"), undefined);
    expect("nights" in r && r.nights).toEqual([0, 1, 2]);
    let s = t.store.getState();
    expect(s.nights.every((n) => n === "p1")).toBe(true);
    t.actions.setLodging("human", P("Osaka Hotel", 34.7, 135.5), [2]);
    s = t.store.getState();
    expect(s.nights[0]).toBe("p1");
    expect(s.nights[2]).toBe("p2");
    expect(t.actions.setLodging("human", P("X"), [7])).toHaveProperty("error");
  });

  it("leg overrides are pair-keyed and undoable", () => {
    const t = threeDayTrip();
    t.actions.setLegOverride("agent", "p1>p2", { mode: "drive" }, undefined, "leg p1>p2 -> drive");
    expect(t.store.getState().legOverrides["p1>p2"].mode).toBe("drive");
    t.actions.undo();
    expect(t.store.getState().legOverrides["p1>p2"]).toBeUndefined();
  });
});

describe("placedHash", () => {
  it("changes when the placed set changes, not when a day reorders", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("human", P("A", 35.70, 139.70), { day: 1 });
    t.actions.addResolvedStop("human", P("B", 35.71, 139.71), { day: 1, position: 2 });
    const h1 = placedHash(t.store.getState());
    t.actions.moveStop("human", "s2", 1, 1);
    expect(placedHash(t.store.getState())).toBe(h1);
    t.actions.moveStop("human", "s1", 2);
    expect(placedHash(t.store.getState())).toBe(h1); // still placed, different day
    t.actions.moveStop("human", "s1", 0); // to candidates -> leaves the placed set
    expect(placedHash(t.store.getState())).not.toBe(h1);
  });

  it("lodging joins the placed set", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("human", P("A"), { day: 1 });
    const h1 = placedHash(t.store.getState());
    t.actions.setLodging("human", P("Hotel", 35.69, 139.70));
    expect(placedHash(t.store.getState())).not.toBe(h1);
  });
});

describe("log discipline", () => {
  it("log is capped at 200 and historyStartRev tracks the cut", () => {
    const t = threeDayTrip();
    t.actions.addResolvedStop("human", P("A"), { day: 1 });
    for (let i = 0; i < 210; i++) t.actions.setDwell("human", "s1", 30 + (i % 5));
    const s = t.store.getState();
    expect(s.log.length).toBe(200);
    expect(s.historyStartRev).toBe(s.log[0].rev - 1);
  });

  it("afterCommit fires with the actor", () => {
    const calls: string[] = [];
    const t = createTripStore({ afterCommit: (_s, actor) => calls.push(actor) });
    t.actions.ensureDays("human", 1);
    t.actions.addResolvedStop("agent", P("A"), { day: 1 });
    expect(calls).toEqual(["human", "agent"]);
  });
});
