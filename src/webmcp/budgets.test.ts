// T10 hardening audits: every tool inside Chrome's recommended budgets
// (30/500/150/~1,500 chars) and every failure path an ERROR string — nothing
// throws raw to the agent, even with every external service down.
import { describe, it, expect } from "vitest";
import { buildTools, type ToolDeps } from "./tools.js";
import { createTripStore, type PlaceInput } from "../store/store.js";

const P = (name: string, lat: number, lon: number): PlaceInput => ({ name, lat, lon, query: name.toLowerCase() });

const ALL_TOOLS = [
  "get_itinerary", "get_changes", "plan_trip", "add_place", "move_stop",
  "set_times", "set_leg_mode", "set_lodging", "arrange_days", "revert_pending",
  "get_planning_guide", "get_leg_options",
];

function servicesDownDeps() {
  const trip = createTripStore();
  const deps: ToolDeps = {
    trip,
    matrix: { ensureFresh: async () => { throw new Error("OSRM down"); } },
    fetchTransit: async () => { throw new Error("MOTIS down"); },
    nominatim: { resolve: async (q) => ({ ok: false, kind: "error", message: `search service unreachable for '${q}' — try again.` }) },
  };
  return { trip, tools: Object.fromEntries(buildTools(deps).map((t) => [t.name, t])) };
}

describe("budget audit (design §1: 30 / 500 / 150 / ~1,500)", () => {
  const { tools } = servicesDownDeps();

  it("exactly the twelve designed tools are registered", () => {
    expect(Object.keys(tools).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it("names: <=30 chars, [a-z_] only; hard spec limits also hold", () => {
    for (const t of Object.values(tools)) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.name.length).toBeLessThanOrEqual(30);
      expect(t.name).toMatch(/^[a-z_]+$/);
    }
  });

  it("descriptions: non-empty, <=500 chars", () => {
    for (const t of Object.values(tools)) {
      expect(t.description.length, t.name).toBeGreaterThan(100);
      expect(t.description.length, t.name).toBeLessThanOrEqual(500);
    }
  });

  it("every parameter description <=150 chars; schemas are objects", () => {
    for (const t of Object.values(tools)) {
      const schema = t.inputSchema as { type: string; properties?: Record<string, { description?: string; items?: { description?: string } }> };
      expect(schema.type, t.name).toBe("object");
      for (const [k, v] of Object.entries(schema.properties ?? {})) {
        if (v.description) expect(v.description.length, `${t.name}.${k}`).toBeLessThanOrEqual(150);
      }
    }
  });

  it("every annotation set is explicit about both hints", () => {
    for (const t of Object.values(tools)) {
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
      expect(typeof t.annotations?.untrustedContentHint, t.name).toBe("boolean");
    }
  });
});

describe("sample result lengths (~1,500 budget)", () => {
  it("get_itinerary on a 3-day / 10-stop trip stays inside the budget", async () => {
    const { trip, tools } = servicesDownDeps();
    trip.actions.ensureDays("human", 3);
    const spots = [
      ["Senso-ji Temple", 35.714, 139.796], ["Tokyo National Museum", 35.718, 139.776],
      ["Ueno Park", 35.712, 139.771], ["Akihabara Electric Town", 35.702, 139.774],
      ["Meiji Shrine", 35.676, 139.699], ["Takeshita Street", 35.671, 139.703],
      ["Shibuya Crossing", 35.659, 139.700], ["Shinjuku Gyoen", 35.685, 139.710],
      ["teamLab Planets", 35.649, 139.789], ["Tsukiji Outer Market", 35.665, 139.770],
    ] as const;
    spots.forEach(([n, la, lo], i) => {
      trip.actions.addResolvedStop("human", P(n, la, lo), { day: (i % 3) + 1 });
    });
    trip.actions.addResolvedStop("human", P("Ghibli Museum", 35.696, 139.570), {});
    trip.actions.addResolvedStop("human", P("Odaiba Seaside Park", 35.630, 139.773), {});
    trip.actions.setLodging("human", P("Hotel Gracery Shinjuku", 35.695, 139.700));
    const out = (await tools.get_itinerary.execute({})) as string;
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain("HUMAN CHANGES");
    expect(out).toContain("YOUR PENDING EDITS");
    // and the per-day view also fits
    const one = (await tools.get_itinerary.execute({ day: 1 })) as string;
    expect(one.length).toBeLessThanOrEqual(1500);
  });

  it("get_changes after a long human session is capped and tells the agent where to page from", async () => {
    const { trip, tools } = servicesDownDeps();
    trip.actions.ensureDays("human", 1);
    trip.actions.addResolvedStop("human", P("Senso-ji Temple", 35.714, 139.796), { day: 1 });
    for (let i = 0; i < 30; i++) trip.actions.setDwell("human", "s1", 30 + i);
    const out = (await tools.get_changes.execute({ since: 0 })) as string;
    expect(out.length).toBeLessThanOrEqual(1500);
    const feed = out.split("\n").filter((l) => l.startsWith("rev"));
    expect(feed.length).toBe(15);
    const lastShown = Number(feed[feed.length - 1].match(/^rev(\d+)/)![1]);
    expect(out).toContain(`(+17 more — get_changes since:${lastShown})`);
    // the read cursor stops at the last SHOWN rev, so the default next call continues the feed
    expect(trip.store.getState().lastAgentReadRev).toBe(lastShown);
    const rest = (await tools.get_changes.execute({})) as string;
    expect(rest.split("\n").filter((l) => l.startsWith("rev")).length).toBe(15);
    expect(rest).toContain("(+2 more — get_changes since:");
    // an explicit re-read of old history never moves the cursor backwards
    const cursor = trip.store.getState().lastAgentReadRev;
    await tools.get_changes.execute({ since: 0 });
    expect(trip.store.getState().lastAgentReadRev).toBe(cursor);
  });

  it("the agent's own revert shows in get_changes as an event, not as an edit id it could revert", async () => {
    const { trip, tools } = servicesDownDeps();
    trip.actions.ensureDays("human", 1);
    trip.actions.addResolvedStop("agent", P("Senso-ji Temple", 35.714, 139.796), { day: 1 }); // e1
    trip.actions.revert("agent", "e1"); // logged as e2, a fate event
    const out = (await tools.get_changes.execute({ since: 0 })) as string;
    expect(out).toContain("e1");
    expect(out).not.toMatch(/agent e2:/);
  });

  it("the planning guide fits", async () => {
    const { tools } = servicesDownDeps();
    expect(((await tools.get_planning_guide.execute({})) as string).length).toBeLessThanOrEqual(1500);
  });
});

describe("ERROR-string audit: nothing throws raw, even with all services down", () => {
  const badArgs: Record<string, unknown>[] = [
    {},
    { day: "one" },
    { name: 42 },
    { stop: null, day: -3 },
    { edits: "e1" },
    { places: "Tokyo", dayCount: 99 },
    { fromStop: "", mode: "teleport" },
    { since: -5.5 },
  ];

  it("every tool returns a string for every junk input", async () => {
    const { tools } = servicesDownDeps();
    for (const t of Object.values(tools)) {
      for (const args of badArgs) {
        const out = await t.execute(args as Record<string, unknown>);
        expect(typeof out, `${t.name} ${JSON.stringify(args)}`).toBe("string");
        expect((out as string).length).toBeGreaterThan(0);
      }
    }
  });

  it("write tools with valid-shaped args but dead services still answer with ERROR guidance", async () => {
    const { trip, tools } = servicesDownDeps();
    trip.actions.ensureDays("human", 1);
    expect(await tools.add_place.execute({ name: "Senso-ji", day: 1 })).toMatch(/^ERROR: .*unreachable.*try again\./);
    trip.actions.addResolvedStop("human", P("A", 35.71, 139.79), { day: 1 });
    trip.actions.addResolvedStop("human", P("B", 35.712, 139.771), { day: 1, position: 2 });
    expect(await tools.set_leg_mode.execute({ day: 1, fromStop: "s1", mode: "transit" })).toBe(
      "ERROR: transit service unreachable — mode unchanged, try again.",
    );
    // matrix down: move still succeeds (estimates), page never blocks (ADR-0001)
    const out = (await tools.move_stop.execute({ stop: "s1", day: 1, position: 2 })) as string;
    expect(out).toMatch(/^ERROR: OSRM down|^Moved \[s1\]/); // ensureFresh throwing must not corrupt state
    expect(trip.store.getState().days[0].stops).toHaveLength(2);
  });
});
