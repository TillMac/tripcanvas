// Primary seam (spec: Testing Decisions): each tool's execute called with
// plain args; the returned string AND resulting store state asserted.
import { describe, it, expect } from "vitest";
import { buildTools, type ToolDeps } from "./tools.js";
import { createTripStore } from "../store/store.js";
import type { ResolveResult } from "../store/nominatim.js";
import type { PlaceCandidate } from "../ported/place-assert.js";

const PLACES: Record<string, PlaceCandidate> = {
  "senso-ji": { placeId: "w/1", name: "Senso-ji", lat: 35.714, lng: 139.796, city: "Taito", types: ["tourism", "attraction"] },
  "ghibli museum, mitaka": { placeId: "w/2", name: "Ghibli Museum", lat: 35.696, lng: 139.570, city: "Mitaka", types: ["tourism", "museum"] },
  "hotel gracery shinjuku": { placeId: "w/3", name: "Hotel Gracery Shinjuku", lat: 35.695, lng: 139.700, city: "Shinjuku", types: ["tourism", "hotel"] },
  "meiji shrine": { placeId: "w/4", name: "Meiji Shrine", lat: 35.676, lng: 139.699, city: "Shibuya", types: ["amenity", "place_of_worship"] },
};

function fakeDeps() {
  const trip = createTripStore();
  const deps: ToolDeps = {
    trip,
    matrix: { ensureFresh: async () => {} },
    fetchTransit: async () => null,
    nominatim: {
      resolve: async (q): Promise<ResolveResult> => {
        const key = q.trim().toLowerCase();
        if (key === "tokyo") return { ok: false, kind: "excluded", message: "'Tokyo' resolved to a whole area (Tokyo) — name a venue." };
        const place = PLACES[key];
        if (!place) return { ok: false, kind: "none", message: `no place found for '${q}' — add a city or landmark to the name.` };
        return { ok: true, place, cached: true };
      },
    },
  };
  const tools = Object.fromEntries(buildTools(deps).map((t) => [t.name, t]));
  return { trip, tools };
}

describe("budgets and annotations", () => {
  it("names <=30 chars [a-z_], descriptions <=500, param descriptions <=150", () => {
    const { tools } = fakeDeps();
    for (const t of Object.values(tools)) {
      expect(t.name.length).toBeLessThanOrEqual(30);
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description.length).toBeLessThanOrEqual(500);
      expect(t.description.length).toBeGreaterThan(0);
      const props = (t.inputSchema as any).properties ?? {};
      for (const [k, v] of Object.entries<any>(props)) {
        if (v.description) expect(v.description.length, `${t.name}.${k}`).toBeLessThanOrEqual(150);
      }
    }
  });

  it("untrustedContentHint marks exactly the tools whose results carry external text", () => {
    const { tools } = fakeDeps();
    expect(tools.add_place.annotations?.untrustedContentHint).toBe(true);
    expect(tools.set_lodging.annotations?.untrustedContentHint).toBe(true);
    expect(tools.move_stop.annotations?.untrustedContentHint).toBe(false);
    expect(tools.set_times.annotations?.untrustedContentHint).toBe(false);
    expect(tools.arrange_days.annotations?.untrustedContentHint).toBe(false);
    expect(tools.get_planning_guide.annotations?.readOnlyHint).toBe(true);
    expect(tools.add_place.annotations?.readOnlyHint).toBe(false);
  });
});

describe("add_place", () => {
  it("adds to a day pending, reports position, dwell, day end", async () => {
    const { trip, tools } = fakeDeps();
    trip.actions.ensureDays("human", 2);
    const out = (await tools.add_place.execute({ name: "Senso-ji", day: 1 })) as string;
    expect(out).toMatch(/^Added \[s1\] Senso-ji \(Taito\) to D1 pos1, dwell 60 \[pending e1\]\. D1 ends \d\d:\d\d, no overflow\.$/);
    const s = trip.store.getState();
    expect(s.days[0].stops).toEqual(["s1"]);
    expect(s.stops.s1.pending).toBe("e1");
    expect(out.length).toBeLessThanOrEqual(1500);
  });

  it("omitted day -> candidate; unresolved and whole-city names -> ERROR strings", async () => {
    const { trip, tools } = fakeDeps();
    trip.actions.ensureDays("human", 1);
    expect(await tools.add_place.execute({ name: "Ghibli Museum, Mitaka" })).toMatch(/^Added \[c1\] Ghibli Museum \(Mitaka\) as a candidate \[pending e1\]\.$/);
    expect(await tools.add_place.execute({ name: "Fantasy Spot" })).toMatch(/^ERROR: no place found/);
    expect(await tools.add_place.execute({ name: "Tokyo" })).toMatch(/^ERROR: .*name a venue/);
    expect(await tools.add_place.execute({ name: "Senso-ji", day: 5 })).toBe("ERROR: day 5 out of range (trip has 1).");
    expect(await tools.add_place.execute({})).toMatch(/^ERROR: invalid name/);
  });
});

describe("move_stop", () => {
  async function seeded() {
    const { trip, tools } = fakeDeps();
    trip.actions.ensureDays("human", 2);
    await tools.add_place.execute({ name: "Senso-ji", day: 1 });
    await tools.add_place.execute({ name: "Meiji Shrine", day: 1, position: 2 });
    return { trip, tools };
  }

  it("moves across days and reports both end times", async () => {
    const { trip, tools } = await seeded();
    const out = (await tools.move_stop.execute({ stop: "s2", day: 2 })) as string;
    expect(out).toMatch(/^Moved \[s2\]: D1 pos2 -> D2 pos1 \[pending e3\]\. D1 ends \d\d:\d\d; D2 ends \d\d:\d\d\.$/);
    expect(trip.store.getState().days[1].stops).toEqual(["s2"]);
  });

  it("day 0 unassigns into candidates with the new id", async () => {
    const { trip, tools } = await seeded();
    const out = (await tools.move_stop.execute({ stop: "s1", day: 0 })) as string;
    expect(out).toMatch(/^Unassigned \[s1\] to candidates as \[c1\] \[pending e3\]; D1 ends \d\d:\d\d\.$/);
    expect(trip.store.getState().candidates).toEqual(["c1"]);
  });

  it("unknown ids and out-of-range days -> ERROR", async () => {
    const { tools } = await seeded();
    expect(await tools.move_stop.execute({ stop: "s99", day: 1 })).toBe("ERROR: no stop [s99] — ids come from get_itinerary.");
    expect(await tools.move_stop.execute({ stop: "s1", day: 6 })).toBe("ERROR: day 6 out of range (trip has 2).");
  });
});

describe("set_times", () => {
  async function seeded() {
    const { trip, tools } = fakeDeps();
    trip.actions.ensureDays("human", 1);
    await tools.add_place.execute({ name: "Senso-ji", day: 1 });
    return { trip, tools };
  }

  it("dwell change reports old -> new and the day end", async () => {
    const { trip, tools } = await seeded();
    const out = (await tools.set_times.execute({ day: 1, stop: "s1", dwellMinutes: 90 })) as string;
    expect(out).toMatch(/^\[s1\] dwell 60 -> 90 \[pending e2\]\. D1 ends \d\d:\d\d\.$/);
    expect(trip.store.getState().stops.s1.dwellMin).toBe(90);
  });

  it("dayStart moves the day; overflow warns", async () => {
    const { trip, tools } = await seeded();
    await tools.set_times.execute({ day: 1, stop: "s1", dwellMinutes: 600 });
    const out = (await tools.set_times.execute({ day: 1, dayStart: "14:00" })) as string;
    expect(out).toContain("D1 starts 14:00");
    expect(out).toContain("WARNING: past 22:00");
    expect(trip.store.getState().days[0].start).toBe("14:00");
  });

  it("validation errors match the design", async () => {
    const { tools } = await seeded();
    expect(await tools.set_times.execute({ day: 1 })).toBe("ERROR: give dayStart, or stop with dwellMinutes/freeMinutesAfter.");
    expect(await tools.set_times.execute({ day: 1, dayStart: "9 am" })).toBe("ERROR: time must be HH:MM 24h.");
    expect(await tools.set_times.execute({ day: 1, stop: "s9", dwellMinutes: 30 })).toBe("ERROR: no stop [s9].");
  });
});

describe("set_lodging", () => {
  it("anchors all nights and reports each day's end", async () => {
    const { trip, tools } = fakeDeps();
    trip.actions.ensureDays("human", 2);
    await tools.add_place.execute({ name: "Senso-ji", day: 1 });
    const out = (await tools.set_lodging.execute({ name: "Hotel Gracery Shinjuku" })) as string;
    expect(out).toMatch(/^Hotel Gracery Shinjuku anchored for nights 0-1 \[pending e2\]\. All days start\/end there\. D1 ends \d\d:\d\d, D2 \d\d:\d\d\.$/);
    const s = trip.store.getState();
    expect(s.nights.every((n) => n === s.nights[0] && n)).toBe(true);
  });

  it("night range and empty-trip errors", async () => {
    const { trip, tools } = fakeDeps();
    expect(await tools.set_lodging.execute({ name: "Hotel Gracery Shinjuku" })).toMatch(/^ERROR: trip has no days yet/);
    trip.actions.ensureDays("human", 2);
    expect(await tools.set_lodging.execute({ name: "Hotel Gracery Shinjuku", nights: [4] })).toBe("ERROR: night 4 out of range (nights 0-1).");
  });
});

describe("arrange_days", () => {
  it("arranges pending with per-day ids and end times", async () => {
    const { trip, tools } = fakeDeps();
    trip.actions.ensureDays("human", 2);
    await tools.add_place.execute({ name: "Senso-ji", day: 1 });
    await tools.add_place.execute({ name: "Meiji Shrine", day: 1, position: 2 });
    await tools.add_place.execute({ name: "Ghibli Museum, Mitaka", day: 2 });
    const out = (await tools.arrange_days.execute({})) as string;
    expect(out).toMatch(/^Arranged 2 days \[pending e4\]\. D1 \[[sc\d ]+\] ends \d\d:\d\d\. D2 \[[sc\d ]+\] ends \d\d:\d\d\. Candidates untouched: 0\. Overflow: none; legs over 40m: \d+|none\./);
    const s = trip.store.getState();
    const placed = s.days.flatMap((d) => d.stops);
    expect(placed.every((sid) => s.stops[sid].pending === "e4")).toBe(true);
  });

  it("fewer than 2 stops -> ERROR", async () => {
    const { trip, tools } = fakeDeps();
    trip.actions.ensureDays("human", 1);
    expect(await tools.arrange_days.execute({})).toBe("ERROR: fewer than 2 stops — nothing to arrange.");
  });
});

describe("review flow through the store (demoable loop)", () => {
  it("human implicit-accept then revert of the remaining edit", async () => {
    const { trip, tools } = fakeDeps();
    trip.actions.ensureDays("human", 1);
    await tools.add_place.execute({ name: "Senso-ji", day: 1 });
    await tools.add_place.execute({ name: "Meiji Shrine", day: 1, position: 2 });
    // human edits the first pending stop -> implicit accept
    trip.actions.setDwell("human", "s1", 45);
    const r = trip.actions.revert("human", "e2");
    expect("reverted" in r && r.reverted).toEqual(["s2"]);
    const s = trip.store.getState();
    expect(s.days[0].stops).toEqual(["s1"]);
    expect(s.stops.s1.pending).toBeUndefined();
  });
});
