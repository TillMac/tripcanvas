// T8 seam tests: get_itinerary / get_changes / revert_pending executes with
// plain args; result strings + store state (read cursor, marks) asserted.
import { describe, it, expect } from "vitest";
import { buildTools, type ToolDeps } from "./tools.js";
import { createTripStore, type PlaceInput } from "../store/store.js";
import type { ResolveResult } from "../store/nominatim.js";

const P = (name: string, lat: number, lon: number): PlaceInput => ({ name, lat, lon, query: name.toLowerCase() });

function fakeDeps() {
  const trip = createTripStore();
  const deps: ToolDeps = {
    trip,
    matrix: { ensureFresh: async () => {} },
    fetchTransit: async () => null,
    nominatim: {
      resolve: async (q): Promise<ResolveResult> => ({
        ok: true,
        cached: true,
        place: { placeId: q, name: q, lat: 35.7, lng: 139.7 },
      }),
    },
  };
  const tools = Object.fromEntries(buildTools(deps).map((t) => [t.name, t]));
  return { trip, tools };
}

function seeded() {
  const x = fakeDeps();
  x.trip.actions.ensureDays("human", 3);
  x.trip.actions.addResolvedStop("human", P("Senso-ji", 35.714, 139.796), { day: 1 });
  x.trip.actions.addResolvedStop("human", P("Ueno Park", 35.712, 139.771), { day: 1, position: 2 });
  x.trip.actions.addResolvedStop("human", P("Shibuya", 35.658, 139.701), { day: 2 });
  x.trip.actions.addResolvedStop("human", P("Ghibli Museum", 35.696, 139.570), {});
  x.trip.actions.setLodging("human", P("Hotel Gracery", 35.695, 139.700));
  return x;
}

describe("get_itinerary", () => {
  it("returns the trip body + both sections, and advances the read cursor", async () => {
    const { trip, tools } = seeded();
    const out = (await tools.get_itinerary.execute({})) as string;
    expect(out).toContain("TRIP rev");
    expect(out).toContain("DAY 1 09:00 from lodging");
    expect(out).toContain("HUMAN CHANGES since your last read (rev0):");
    expect(out).toContain("YOUR PENDING EDITS: none");
    expect(out).toContain("Candidates: [c1] Ghibli Museum");
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(trip.store.getState().lastAgentReadRev).toBe(trip.store.getState().rev);
    // second read: human changes now empty, never an empty string
    const out2 = (await tools.get_itinerary.execute({})) as string;
    expect(out2).toContain("HUMAN CHANGES since your last read");
    expect(out2).toContain(": none");
  });

  it("empty trip is guidance plus sections", async () => {
    const { tools } = fakeDeps();
    const out = (await tools.get_itinerary.execute({})) as string;
    expect(out).toContain("Trip is empty — use plan_trip or add_place.");
    expect(out).toContain("YOUR PENDING EDITS: none");
  });

  it("trips over 4 days auto-compact; day param returns one day full-size", async () => {
    const { trip, tools } = seeded();
    trip.actions.ensureDays("human", 5);
    const out = (await tools.get_itinerary.execute({})) as string;
    expect(out).toContain("Pass day:N for stop detail");
    expect(out).toMatch(/DAY 1 [\d:-]+ 2 stops: Senso-ji -> Ueno Park/);
    const one = (await tools.get_itinerary.execute({ day: 1 })) as string;
    expect(one).toContain("[s1] Senso-ji");
    expect(one).not.toContain("DAY 2");
    expect(await tools.get_itinerary.execute({ day: 9 })).toBe("ERROR: day 9 out of range (trip has 5).");
  });

  it("lists human changes since the last read, then pending edits with marks", async () => {
    const { trip, tools } = seeded();
    await tools.get_itinerary.execute({});
    trip.actions.setDwell("human", "s1", 45);
    trip.actions.moveStop("human", "s3", 1);
    await tools.add_place.execute({ name: "Meiji Shrine", day: 2 });
    const out = (await tools.get_itinerary.execute({})) as string;
    expect(out).toContain("- set [s1] dwell 60 -> 45");
    expect(out).toMatch(/- moved \[s3\]/);
    expect(out).toMatch(/YOUR PENDING EDITS \(1\): e1 added \[s\d\] Meiji Shrine/);
    expect(out).toMatch(/Meiji Shrine\* /); // pending mark in the day block
  });
});

describe("get_changes", () => {
  it("quiet feed reports no changes plus the pending footer", async () => {
    const { tools } = seeded();
    await tools.get_itinerary.execute({});
    const out = (await tools.get_changes.execute({})) as string;
    expect(out).toMatch(/^No changes since rev \d+\.\nPending now: none$/);
  });

  it("lists revisions with actors and per-edit fates", async () => {
    const { trip, tools } = seeded();
    await tools.get_itinerary.execute({});
    await tools.add_place.execute({ name: "Meiji Shrine", day: 2 });
    await tools.add_place.execute({ name: "teamLab", day: 3 });
    const s = trip.store.getState();
    const [e1, e2] = ["e1", "e2"];
    trip.actions.accept(e1);
    trip.actions.revert("human", e2);
    const out = (await tools.get_changes.execute({ since: s.lastAgentReadRev })) as string;
    expect(out).toMatch(/rev\d+ agent e1: added .*\[accepted\]/);
    expect(out).toMatch(/rev\d+ agent e2: added .*\[reverted\]/);
    expect(out).toMatch(/rev\d+ human: accepted e1/);
    expect(out).toContain("Pending now: none");
  });

  it("a since older than kept history falls back to full state", async () => {
    const { trip, tools } = seeded();
    trip.store.setState({ historyStartRev: 30, lastAgentReadRev: 40 });
    const out = (await tools.get_changes.execute({ since: 10 })) as string;
    expect(out).toMatch(/^History starts at rev 31; full state instead:\nTRIP rev/);
  });
});

describe("revert_pending", () => {
  it("reverts listed edits and reports what is still pending", async () => {
    const { trip, tools } = seeded();
    await tools.add_place.execute({ name: "Meiji Shrine", day: 2 });
    await tools.add_place.execute({ name: "teamLab", day: 3 });
    await tools.add_place.execute({ name: "Tower", day: 3 });
    const out = (await tools.revert_pending.execute({ edits: ["e1", "e2"] })) as string;
    expect(out).toMatch(/^Reverted e1, e2; rev now \d+\. 1 edit still pending \(e3\)\.$/);
    const s = trip.store.getState();
    expect(s.days[1].stops).toHaveLength(1); // only the human's Shibuya
  });

  it("all:true reverts everything of the agent's", async () => {
    const { trip, tools } = seeded();
    await tools.add_place.execute({ name: "Meiji Shrine", day: 2 });
    await tools.add_place.execute({ name: "teamLab", day: 3 });
    const out = (await tools.revert_pending.execute({ all: true })) as string;
    expect(out).toMatch(/^Reverted e1, e2; rev now \d+\. No edits still pending\.$/);
    expect(trip.store.getState().days[2].stops).toEqual([]);
  });

  it("fully accepted edits error; empty state errors", async () => {
    const { trip, tools } = seeded();
    expect(await tools.revert_pending.execute({ all: true })).toBe("ERROR: no pending edits.");
    await tools.add_place.execute({ name: "Meiji Shrine", day: 2 });
    trip.actions.accept("e1");
    expect(await tools.revert_pending.execute({ edits: ["e1"] })).toBe(
      "ERROR: e1 was fully accepted — ask the human to undo.",
    );
  });

  it("partial batch reports kept members", async () => {
    const { trip, tools } = fakeDeps();
    trip.actions.ensureDays("human", 1);
    await tools.plan_trip.execute({ places: ["A one", "B two", "C three"], dayCount: 1 });
    // human touches one planned stop
    const sid = trip.store.getState().days[0].stops[0];
    trip.actions.setDwell("human", sid, 45);
    const out = (await tools.revert_pending.execute({ all: true })) as string;
    expect(out).toMatch(/2 of 3 stops reverted; \[s\d\] was accepted by the human and stays\./);
    const s = trip.store.getState();
    expect(s.days[0].stops).toEqual([sid]);
  });
});
