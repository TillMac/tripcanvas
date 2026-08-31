import { describe, it, expect, vi } from "vitest";
import { makeTransitFetcher, applyTransitLeg, nearFutureWeekdayISO } from "./transit.js";
import { createTripStore, type PlaceInput } from "./store.js";
import type { TransitLeg } from "../ported/motis.js";

const P = (name: string, lat: number, lon: number): PlaceInput => ({ name, lat, lon, query: name.toLowerCase() });

const MOTIS_OK = {
  itineraries: [{
    duration: 1680, transfers: 1,
    legs: [
      { mode: "WALK", from: { name: "A", lat: 35.71, lon: 139.79 }, to: { name: "Ueno Sta", lat: 35.712, lon: 139.777 }, duration: 240 },
      { mode: "SUBWAY", from: { name: "Ueno Sta", lat: 35.712, lon: 139.777 }, to: { name: "END", lat: 35.712, lon: 139.771 }, duration: 1440, routeShortName: "G", headsign: "Shibuya" },
    ],
  }],
};

function okFetch(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

describe("nearFutureWeekdayISO", () => {
  it("always lands on a weekday", () => {
    for (let d = 0; d < 7; d++) {
      const now = new Date(2026, 8, 1 + d);
      const wd = new Date(nearFutureWeekdayISO(now)).getDay();
      expect(wd).toBeGreaterThan(0);
      expect(wd).toBeLessThan(6);
    }
  });
});

describe("makeTransitFetcher", () => {
  it("parses an itinerary and names the destination (END replaced)", async () => {
    const f = makeTransitFetcher({ fetchFn: okFetch(MOTIS_OK) });
    const leg = await f(
      { id: "p1", name: "A", lat: 35.71, lon: 139.79, query: "a" },
      { id: "p2", name: "Ueno Park", lat: 35.712, lon: 139.771, query: "b" },
    );
    expect(leg?.totalMin).toBe(28);
    expect(leg?.steps[1].toName).toBe("Ueno Park");
  });

  it("retries once on failure, then throws", async () => {
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { ok: true, status: 200, json: async () => MOTIS_OK };
    }) as unknown as typeof fetch;
    const f = makeTransitFetcher({ fetchFn: flaky });
    const leg = await f({ id: "p1", name: "A", lat: 0, lon: 0, query: "a" }, { id: "p2", name: "B", lat: 1, lon: 1, query: "b" });
    expect(leg).not.toBeNull();
    expect(calls).toBe(2);

    const dead = vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
    await expect(makeTransitFetcher({ fetchFn: dead })({ id: "p1", name: "A", lat: 0, lon: 0, query: "a" }, { id: "p2", name: "B", lat: 1, lon: 1, query: "b" })).rejects.toThrow();
  });

  it("no itineraries -> null", async () => {
    const f = makeTransitFetcher({ fetchFn: okFetch({ itineraries: [] }) });
    expect(await f({ id: "p1", name: "A", lat: 0, lon: 0, query: "a" }, { id: "p2", name: "B", lat: 1, lon: 1, query: "b" })).toBeNull();
  });
});

describe("applyTransitLeg", () => {
  function seeded() {
    const t = createTripStore();
    t.actions.ensureDays("human", 1);
    t.actions.addResolvedStop("human", P("A", 35.71, 139.79), { day: 1 });
    t.actions.addResolvedStop("human", P("B", 35.712, 139.771), { day: 1, position: 2 });
    t.actions.setLodging("human", P("Hotel", 35.70, 139.78));
    return t;
  }

  it("applies a pair-keyed transit override; human actor leaves no pending mark", async () => {
    const t = seeded();
    const leg: TransitLeg = { totalMin: 28, transfers: 1, steps: [] };
    const r = await applyTransitLeg(t, async () => leg, "human", 1, "s2");
    expect(r.ok).toBe(true);
    const s = t.store.getState();
    const key = `${s.stops.s1.place}>${s.stops.s2.place}`;
    expect(s.legOverrides[key]?.mode).toBe("transit");
    expect(s.legOverrides[key]?.transit?.totalMin).toBe(28);
    expect(s.stops.s2.pending).toBeUndefined();
  });

  it("agent actor marks the arriving stop pending", async () => {
    const t = seeded();
    const r = await applyTransitLeg(t, async () => ({ totalMin: 28, transfers: 0, steps: [] }), "agent", 1, "s2");
    expect(r.ok).toBe(true);
    expect(t.store.getState().stops.s2.pending).toBe("e1");
  });

  it("first stop's leg departs the lodging anchor", async () => {
    const t = seeded();
    let captured: [string, string] | null = null;
    await applyTransitLeg(t, async (from, to) => { captured = [from.name, to.name]; return { totalMin: 10, transfers: 0, steps: [] }; }, "human", 1, "s1");
    expect(captured).toEqual(["Hotel", "A"]);
  });

  it("no route / unreachable keep the mode and explain", async () => {
    const t = seeded();
    const r1 = await applyTransitLeg(t, async () => null, "human", 1, "s2");
    expect(r1).toMatchObject({ ok: false });
    if (!r1.ok) expect(r1.message).toMatch(/^ERROR: no transit route found — leg stays \w+ \(\d+m\)\.$/);
    const r2 = await applyTransitLeg(t, async () => { throw new Error("down"); }, "human", 1, "s2");
    if (!r2.ok) expect(r2.message).toBe("ERROR: transit service unreachable — mode unchanged, try again.");
    expect(t.store.getState().legOverrides).toEqual({});
  });
});
