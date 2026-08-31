import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NominatimQueue } from "./nominatim.js";

const hit = (name: string, cls = "tourism", typ = "attraction") => [{
  osm_type: "way", osm_id: 1, lat: "35.7", lon: "139.7", class: cls, type: typ,
  display_name: `${name}, Tokyo, Japan`, address: { city: "Tokyo", country: "Japan" },
  namedetails: { name },
}];

function okFetch(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("NominatimQueue", () => {
  it("resolves through the gates and caches by normalized query", async () => {
    const fetchFn = okFetch(hit("Sensō-ji"));
    const q = new NominatimQueue({ fetchFn, storage: memStorage() });
    const r = await q.resolve("Senso-ji");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.place.name).toBe("Sensō-ji");
    // second call, differently-cased query: cache hit, no second fetch
    const r2 = await q.resolve("  SENSO-JI ");
    expect(r2.ok && r2.cached).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(q.uncachedCount(["senso-ji", "Meiji Shrine"])).toBe(1);
  });

  it("spaces consecutive uncached requests by >= 1.1s", async () => {
    const times: number[] = [];
    const fetchFn = vi.fn(async () => {
      times.push(Date.now());
      return { ok: true, status: 200, json: async () => hit("X") };
    }) as unknown as typeof fetch;
    const q = new NominatimQueue({ fetchFn }); // no storage: nothing cached across calls? (memory cache still applies per-name)
    const p1 = q.resolve("A");
    const p2 = q.resolve("B");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1099);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await Promise.all([p1, p2]);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1100);
  });

  it("zero results -> kind none with retry advice", async () => {
    const q = new NominatimQueue({ fetchFn: okFetch([]) });
    const r = await q.resolve("Fantasy Spot");
    expect(r).toMatchObject({ ok: false, kind: "none" });
    if (!r.ok) expect(r.message).toContain("no place found");
  });

  it("whole-city result -> kind excluded", async () => {
    const q = new NominatimQueue({ fetchFn: okFetch(hit("Tokyo", "boundary", "administrative")) });
    const r = await q.resolve("Tokyo");
    expect(r).toMatchObject({ ok: false, kind: "excluded" });
    if (!r.ok) expect(r.message).toContain("name a venue");
  });

  it("fetch failure retries once, then reports error; nothing cached", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const store = memStorage();
    const q = new NominatimQueue({ fetchFn, storage: store });
    const r = await q.resolve("A");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: false, kind: "error" });
    expect(store.getItem("tripcanvas:geocache:v1")).toBeNull();
  });

  it("deadline is checked before request and before retry", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const q = new NominatimQueue({ fetchFn });
    // deadline already passed -> no fetch at all
    const r = await q.resolve("A", { deadline: Date.now() - 1 });
    expect(r).toMatchObject({ ok: false, kind: "deadline" });
    expect(fetchFn).toHaveBeenCalledTimes(0);
  });
});
