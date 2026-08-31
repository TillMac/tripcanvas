import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTripStore, type PlaceInput } from "./store.js";
import { loadTrip, attachPersistence, TRIP_KEY } from "./persist.js";

const P = (name: string): PlaceInput => ({ name, lat: 35.7, lon: 139.7, query: name.toLowerCase() });

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    map: m,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("persistence", () => {
  it("round-trips the trip (minus matrices/resolvingPins), debounced on rev change", async () => {
    const storage = memStorage();
    const t = createTripStore();
    attachPersistence(t.store, storage);
    t.actions.ensureDays("human", 2);
    t.actions.addResolvedStop("agent", P("A"), { day: 1 });
    t.store.setState({ matrices: { ids: ["p1"], forHash: "p1", stale: false, walk: [[0]] }, resolvingPins: [{ name: "x", lat: 1, lon: 2 }] });
    expect(storage.map.size).toBe(0); // debounce pending
    await vi.advanceTimersByTimeAsync(251);
    const raw = storage.getItem(TRIP_KEY)!;
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("resolvingPins");
    expect(raw).not.toContain("forHash");

    const loaded = loadTrip(storage);
    expect(loaded.days).toHaveLength(2);
    expect(loaded.stops.s1.pending).toBe("e1");
    expect(loaded.rev).toBe(t.store.getState().rev);
    expect(loaded.matrices.walk).toBeUndefined(); // reset, not persisted
    expect(loaded.resolvingPins).toEqual([]);
  });

  it("two rapid commits produce one write", async () => {
    const storage = memStorage();
    const setSpy = vi.spyOn(storage, "setItem");
    const t = createTripStore();
    attachPersistence(t.store, storage);
    t.actions.ensureDays("human", 1);
    t.actions.addResolvedStop("human", P("A"), { day: 1 });
    await vi.advanceTimersByTimeAsync(251);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it("corrupt storage yields a fresh trip", () => {
    const storage = memStorage();
    storage.setItem(TRIP_KEY, "{not json");
    expect(loadTrip(storage).rev).toBe(0);
    storage.setItem(TRIP_KEY, JSON.stringify({ rev: "nope" }));
    expect(loadTrip(storage).rev).toBe(0);
    expect(loadTrip(memStorage()).days).toEqual([]);
  });
});
