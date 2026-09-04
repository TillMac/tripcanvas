// T8 seam tests: get_itinerary / get_changes / revert_pending executes with
// plain args; result strings + store state (read cursor, marks) asserted.
import { describe, it, expect } from "vitest";
import { buildTools, type ToolDeps } from "./tools.js";
import { createTripStore, type PlaceInput } from "../store/store.js";
import type { ResolveResult } from "../store/nominatim.js";

const P = (name: string, lat: number, lon: number): PlaceInput => ({ name, lat, lon, query: name.toLowerCase() });

function fakeDeps(fetchTransit: ToolDeps["fetchTransit"] = async () => null) {
  const trip = createTripStore();
  const deps: ToolDeps = {
    trip,
    matrix: { ensureFresh: async () => {} },
    fetchTransit,
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

function seeded(fetchTransit?: ToolDeps["fetchTransit"]) {
  const x = fakeDeps(fetchTransit);
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

describe("get_leg_options", () => {
  const withTransit: ToolDeps["fetchTransit"] = async () => ({
    totalMin: 51,
    transfers: 1,
    steps: [
      { mode: "transit", line: "Ginza Line", color: null, headsign: "Shibuya", durationMin: 30, fromName: "Asakusa", toName: "Ueno", coords: [] },
      { mode: "walk", line: null, color: null, headsign: null, durationMin: 3, fromName: "Ueno", toName: "Ueno Park", coords: [] },
    ],
  });

  /** Cover the s1->s2 pair with routed times so both numbers are exact. */
  function withMatrices(trip: ReturnType<typeof seeded>["trip"]) {
    const s = trip.store.getState();
    const [a, b] = s.days[0].stops.map((sid) => s.stops[sid].place);
    trip.store.setState({
      matrices: { ids: [a, b], walk: [[0, 78 * 60], [78 * 60, 0]], drive: [[0, 21 * 60], [21 * 60, 0]], forHash: "x", stale: false },
    });
  }

  it("compares all three modes and changes nothing", async () => {
    const { trip, tools } = seeded(withTransit);
    withMatrices(trip);
    const before = trip.store.getState();
    const out = (await tools.get_leg_options.execute({ day: 1, fromStop: "s1" })) as string;
    expect(out).toContain("walk 78 min");
    expect(out).toContain("drive 21 min");
    expect(out).toContain("transit 51 min, 1 transfer");
    expect(out).toContain("Ginza Line toward Shibuya, off at Ueno");
    expect(out).toContain("Current: drive");
    expect(out.length).toBeLessThanOrEqual(1500);
    const after = trip.store.getState();
    expect(after.rev).toBe(before.rev);
    expect(after.log.length).toBe(before.log.length);
    expect(after.legOverrides).toEqual(before.legOverrides);
  });

  it("says so when no transit route comes back", async () => {
    const { tools } = seeded(); // fetchTransit returns null
    const out = (await tools.get_leg_options.execute({ day: 1, fromStop: "s1" })) as string;
    expect(out).toContain("transit: no route found");
    expect(out).toMatch(/walk ~\d+ min · drive ~\d+ min/); // no matrices -> estimates
  });

  it("'lodging' names the day's first leg; a day without lodging errors", async () => {
    const { tools } = seeded(withTransit);
    const out = (await tools.get_leg_options.execute({ day: 1, fromStop: "lodging" })) as string;
    expect(out).toMatch(/^Leg lodging->\[s1\] Hotel Gracery -> Senso-ji, /);

    const bare = fakeDeps();
    bare.trip.actions.ensureDays("human", 1);
    bare.trip.actions.addResolvedStop("human", P("Senso-ji", 35.714, 139.796), { day: 1 });
    bare.trip.actions.addResolvedStop("human", P("Ueno Park", 35.712, 139.771), { day: 1, position: 2 });
    expect(await bare.tools.get_leg_options.execute({ day: 1, fromStop: "lodging" })).toBe(
      "ERROR: day 1 has no lodging — its first leg does not exist.",
    );
  });

  it("unknown stop and out-of-range day error like set_leg_mode; the last stop reads the return leg", async () => {
    const { tools } = seeded();
    expect(await tools.get_leg_options.execute({ day: 1, fromStop: "s99" })).toBe(
      "ERROR: no stop [s99] on day 1 — ids come from get_itinerary.",
    );
    expect(await tools.get_leg_options.execute({ day: 9, fromStop: "s1" })).toBe(
      "ERROR: day 9 out of range (trip has 3).",
    );
    expect(await tools.get_leg_options.execute({ day: 1, fromStop: "s2" })).toMatch(
      /^Leg \[s2\]->lodging .* -> Hotel Gracery, .*Nothing changed/,
    );
  });
});
