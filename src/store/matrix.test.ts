import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTripStore, placedHash, type PlaceInput } from "./store.js";
import { MatrixService, OSRM_BACKOFF_MS, TABLE_TIMEOUT_MS } from "./matrix.js";

const P = (name: string, lat: number, lon: number): PlaceInput => ({ name, lat, lon, query: name.toLowerCase() });

function osrmFetch() {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const n = (url.match(/table\/v1\/\w+\/(.*)\?/)?.[1] ?? "").split(";").length;
    const row = Array.from({ length: n }, (_, j) => j * 600);
    return { ok: true, status: 200, json: async () => ({ code: "Ok", durations: Array.from({ length: n }, () => row.slice()) }) };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function wired(deps: { fetchFn?: typeof fetch; storage?: any } = {}) {
  const { fn } = osrmFetch();
  const fetchFn = deps.fetchFn ?? fn;
  let svc: MatrixService = null as any;
  const t = createTripStore({ afterCommit: (s, actor) => svc.onCommit(s, actor) });
  svc = new MatrixService(t.store, { fetchFn, storage: deps.storage });
  return { t, svc, fetchFn: fetchFn as any };
}

describe("MatrixService", () => {
  it("human commit changing the placed set fetches after the 500ms debounce", async () => {
    const { t, fetchFn } = wired();
    t.actions.ensureDays("human", 1);
    t.actions.addResolvedStop("human", P("A", 35.70, 139.70), { day: 1 });
    expect(t.store.getState().matrices.stale).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await vi.runAllTimersAsync();
    expect(fetchFn).toHaveBeenCalledTimes(2); // walk + drive, parallel
    const m = t.store.getState().matrices;
    expect(m.stale).toBe(false);
    expect(m.forHash).toBe(placedHash(t.store.getState()));
    expect(m.walk).toBeDefined();
  });

  it("rapid human commits collapse into one refresh; reorders never refetch", async () => {
    const { t, fetchFn } = wired();
    t.actions.ensureDays("human", 1);
    t.actions.addResolvedStop("human", P("A", 35.70, 139.70), { day: 1 });
    t.actions.addResolvedStop("human", P("B", 35.71, 139.71), { day: 1, position: 2 });
    await vi.runAllTimersAsync();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // reorder: same placed set, no new fetch
    t.actions.moveStop("human", "s2", 1, 1);
    await vi.runAllTimersAsync();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("agent commits refresh immediately and ensureFresh awaits real times", async () => {
    const { t, svc, fetchFn } = wired();
    t.actions.ensureDays("human", 1);
    await vi.runAllTimersAsync();
    t.actions.addResolvedStop("agent", P("A", 35.70, 139.70), { day: 1 });
    const p = svc.ensureFresh();
    await vi.runAllTimersAsync();
    await p;
    expect(fetchFn).toHaveBeenCalled();
    expect(t.store.getState().matrices.stale).toBe(false);
  });

  it("fetch failure keeps the page editable: stale stays true, old matrix kept", async () => {
    const bad = vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const { t } = wired({ fetchFn: bad });
    t.actions.ensureDays("human", 1);
    t.actions.addResolvedStop("human", P("A", 35.70, 139.70), { day: 1 });
    await vi.runAllTimersAsync();
    expect(t.store.getState().matrices.stale).toBe(true);
    // still editable
    const r = t.actions.setDwell("human", "s1", 90);
    expect("sid" in r).toBe(true);
  });

  it("per-hash localStorage cache skips OSRM on an unchanged place set", async () => {
    const storage = memStorage();
    const a = wired({ storage });
    a.t.actions.ensureDays("human", 1);
    a.t.actions.addResolvedStop("human", P("A", 35.70, 139.70), { day: 1 });
    await vi.runAllTimersAsync();
    expect(a.fetchFn).toHaveBeenCalledTimes(2);

    // simulate reload: same trip content, fresh service + store, same storage
    const b = wired({ storage });
    b.t.actions.ensureDays("human", 1);
    b.t.actions.addResolvedStop("human", P("A", 35.70, 139.70), { day: 1 });
    await vi.runAllTimersAsync();
    expect(b.fetchFn).not.toHaveBeenCalled();
    expect(b.t.store.getState().matrices.stale).toBe(false);
  });
});

describe("MatrixService — plan_trip's inline fetch and the commit refresh share one request", () => {
  it("a commit for the set already being fetched inline does not hit the router again", async () => {
    const pending: ((v: any) => void)[] = [];
    const fn = vi.fn((url: string) => new Promise((resolve) => {
      const n = (url.match(/table\/v1\/\w+\/(.*)\?/)?.[1] ?? "").split(";").length;
      const row = Array.from({ length: n }, (_, j) => j * 600);
      pending.push(() => resolve({ ok: true, status: 200, json: async () => ({ code: "Ok", durations: Array.from({ length: n }, () => row.slice()) }) }));
    })) as unknown as typeof fetch;
    const { t, svc } = wired({ fetchFn: fn });
    t.actions.ensureDays("agent", 1);
    const a = { id: "p1", ...P("A", 35.71, 139.79) };
    const inline = svc.fetchTablesFor([a]);
    expect(fn).toHaveBeenCalledTimes(2); // foot + car
    // plan_trip commits the same place while the inline fetch is still in flight
    t.actions.addResolvedStop("agent", P("A", 35.71, 139.79), { day: 1 });
    const fresh = svc.ensureFresh();
    expect(fn).toHaveBeenCalledTimes(2); // shared, not re-requested
    pending.forEach((r) => r(null));
    await inline;
    await vi.runAllTimersAsync();
    await fresh;
    expect(t.store.getState().matrices.stale).toBe(false);
    expect(t.store.getState().matrices.walk).toBeDefined();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("MatrixService — routing service outage", () => {
  /** FOSSGIS hangs until aborted; the OSRM demo (car only) answers. */
  function outageFetch() {
    const calls: string[] = [];
    const fn = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      calls.push(url);
      if (url.includes("router.project-osrm.org")) {
        const n = (url.match(/driving\/(.*)\?/)?.[1] ?? "").split(";").length;
        const row = Array.from({ length: n }, (_, j) => j * 600);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ code: "Ok", durations: Array.from({ length: n }, () => row.slice()) }) });
      }
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it("a hanging table fetch is abandoned after the timeout; drive falls back to the OSRM demo, walk stays estimated", async () => {
    const { fn, calls } = outageFetch();
    const { t, svc } = wired({ fetchFn: fn });
    t.actions.ensureDays("agent", 1);
    t.actions.addResolvedStop("agent", P("A", 35.71, 139.79), { day: 1 });
    t.actions.addResolvedStop("agent", P("B", 35.70, 139.77), { day: 1 });
    const done = svc.ensureFresh();
    await vi.advanceTimersByTimeAsync(TABLE_TIMEOUT_MS + 50);
    await done;
    const m = t.store.getState().matrices;
    expect(m.forHash).toBe(placedHash(t.store.getState()));
    expect(m.drive).toBeDefined();
    expect(m.walk).toBeUndefined();
    expect(m.stale).toBe(false);
    expect(calls.filter((u) => u.includes("router.project-osrm.org")).length).toBe(2); // once per placed set (p1, then p1;p2)
  });

  it("after a 429, FOSSGIS is left alone until the backoff passes; a failed attempt is never retried in the same ensureFresh", async () => {
    const calls: string[] = [];
    const fn = vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: false, status: 429, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const fossgis = () => calls.filter((u) => u.includes("routing.openstreetmap.de")).length;
    const { t, svc } = wired({ fetchFn: fn });
    t.actions.ensureDays("agent", 1);
    t.actions.addResolvedStop("agent", P("A", 35.71, 139.79), { day: 1 });
    t.actions.addResolvedStop("agent", P("B", 35.70, 139.77), { day: 1 });
    await svc.ensureFresh();
    expect(t.store.getState().matrices.stale).toBe(true);
    const n = calls.length;
    const f = fossgis();
    expect(f).toBeLessThanOrEqual(4); // at most foot+car per placed-set attempt, never a re-check storm
    await svc.ensureFresh();
    await svc.ensureFresh();
    expect(fossgis()).toBe(f); // backing off
    expect(calls.length - n).toBeLessThanOrEqual(2); // only the fallback router, once per attempt
    await vi.advanceTimersByTimeAsync(OSRM_BACKOFF_MS + 10);
    await svc.ensureFresh();
    expect(fossgis()).toBeGreaterThan(f); // one retry window later
  });
});
