import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTripStore, placedHash, type PlaceInput } from "./store.js";
import { MatrixService } from "./matrix.js";

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
