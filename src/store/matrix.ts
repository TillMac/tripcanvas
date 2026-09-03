// Matrix refresh policy (docs/design/tool-layer.md §5): refetch walk+drive
// OSRM tables only when the placed-set hash changes; human-driven commits
// debounce 500ms trailing, tool-driven changes refresh immediately and tools
// await ensureFresh() inline. Matrix arrival is derived data: no rev, no log.
import type { StoreApi } from "zustand/vanilla";
import { osrmTableUrl, parseOsrmTable, type DurationMatrix } from "../ported/osrm.js";
import { placedHash } from "./store.js";
import type { Actor, TripState } from "./types.js";

const CACHE_PREFIX = "tripcanvas:matrix:";
export const MATRIX_DEBOUNCE_MS = 500;
/** Every table request is bounded: a hung router must never hold a tool past Chrome's 30s budget. */
export const TABLE_TIMEOUT_MS = 6_000;
/** After a FOSSGIS failure (429/outage) leave it alone for a while instead of hammering its limiter. */
export const OSRM_BACKOFF_MS = 15_000;
/** The OSRM demo server has only a driving profile; walk falls back to estimates. */
const fallbackCarTableUrl = (coords: string) =>
  `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`;
const isFossgis = (url: string) => url.startsWith("https://routing.openstreetmap.de/");

export interface MatrixDeps {
  fetchFn?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem">;
  debounceMs?: number;
  timeoutMs?: number;
}

export class MatrixService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private fetchFn: typeof fetch;
  /** FOSSGIS-only backoff; the fallback router is still tried. */
  private blockedUntil = 0;
  /** Hash of the last refresh attempt (success or not) — ensureFresh's re-check key. */
  private lastAttemptHash = "";
  /** One pair fetch per coordinate set: plan_trip's inline table fetch and the
   *  commit-triggered refresh share it instead of racing FOSSGIS into a 429. */
  private pairInflight = new Map<string, Promise<{ walk?: DurationMatrix; drive?: DurationMatrix } | null>>();

  constructor(
    private store: StoreApi<TripState>,
    private deps: MatrixDeps = {},
  ) {
    this.fetchFn = deps.fetchFn ?? ((...a) => fetch(...a));
  }

  /** Hook into commit(afterCommit). Reorders/cross-day moves keep the hash — no refetch. */
  onCommit(state: TripState, actor: Actor): void {
    const hash = placedHash(state);
    if (hash === state.matrices.forHash) return;
    if (!state.matrices.stale) {
      this.store.setState({ matrices: { ...this.store.getState().matrices, stale: true } });
    }
    if (actor === "human") {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.refresh();
      }, this.deps.debounceMs ?? MATRIX_DEBOUNCE_MS);
    } else {
      void this.refresh();
    }
  }

  /** Tools await this so returned times are real; plan/arrange await in-flight fetches. */
  async ensureFresh(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const s = this.store.getState();
    const before = placedHash(s);
    if (before === s.matrices.forHash && !s.matrices.stale) return;
    await (this.inflight ?? this.refresh());
    // A newer commit may have changed the set while the fetch ran. A FAILED
    // attempt for the current set is not a reason to refetch (that storm is
    // what blew the 30s budget during the FOSSGIS outage).
    if (this.lastAttemptHash !== before) await this.refresh();
  }

  /** Fetch walk+drive tables for an explicit place set (plan_trip §3 step 4,
   *  BEFORE grouping) and seed the per-hash cache so the post-commit refresh
   *  is instant. Returns null on failure (caller falls back to estimates). */
  async fetchTablesFor(
    places: { id: string; lat: number; lon: number }[],
  ): Promise<{ walk?: DurationMatrix; drive?: DurationMatrix; ids: string[] } | null> {
    const ids = places.map((p) => p.id).sort();
    const byId = new Map(places.map((p) => [p.id, p]));
    const coords = ids.map((pid) => `${byId.get(pid)!.lon},${byId.get(pid)!.lat}`).join(";");
    const cached = this.cacheGet(coords);
    if (cached) return { ...cached, ids };
    const pair = await this.fetchPair(coords);
    if (!pair) return null;
    if (pair.walk && pair.drive) this.cacheSet(coords, pair.walk, pair.drive);
    return { ...pair, ids };
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    const s = this.store.getState();
    const hash = placedHash(s);
    if (!hash) {
      this.store.setState({ matrices: { ids: [], forHash: "", stale: false } });
      return;
    }
    const ids = hash.split(";");
    this.lastAttemptHash = hash;

    // Cache by coordinates: place ids restart at p1 for every new trip, so an
    // id-keyed entry would hand another trip's times to this one as real.
    const coords = ids.map((pid) => `${s.places[pid].lon},${s.places[pid].lat}`).join(";");
    const cached = this.cacheGet(coords);
    if (cached) {
      this.store.setState({ matrices: { walk: cached.walk, drive: cached.drive, ids, forHash: hash, stale: false } });
      return;
    }

    const pair = await this.fetchPair(coords);
    if (pair) {
      // A missing profile (walk) simply falls through to estimates per leg.
      this.store.setState({ matrices: { ...pair, ids, forHash: hash, stale: false } });
      if (pair.walk && pair.drive) this.cacheSet(coords, pair.walk, pair.drive);
    } else {
      // Keep the old matrix (covered pairs still real); schedule falls back to
      // estimates for uncovered pairs; page stays editable (ADR-0001).
      const cur = this.store.getState().matrices;
      this.store.setState({ matrices: { ...cur, stale: true } });
    }
  }

  private fetchPair(coords: string): Promise<{ walk?: DurationMatrix; drive?: DurationMatrix } | null> {
    const hit = this.pairInflight.get(coords);
    if (hit) return hit;
    const p = this.doFetchPair(coords).finally(() => this.pairInflight.delete(coords));
    this.pairInflight.set(coords, p);
    return p;
  }

  /** Both profiles in parallel; whichever answers is kept. Null when neither did. */
  private async doFetchPair(coords: string): Promise<{ walk?: DurationMatrix; drive?: DurationMatrix } | null> {
    const [walk, drive] = await Promise.allSettled([this.fetchTable("foot", coords), this.fetchTable("car", coords)]);
    if (walk.status === "rejected" && drive.status === "rejected") return null;
    return {
      ...(walk.status === "fulfilled" ? { walk: walk.value } : {}),
      ...(drive.status === "fulfilled" ? { drive: drive.value } : {}),
    };
  }

  /** foot → FOSSGIS; car → OSRM demo, then FOSSGIS. Each attempt is timeout-bounded. */
  private async fetchTable(profile: "foot" | "car", coords: string): Promise<DurationMatrix> {
    // Split the load: foot on FOSSGIS, car on the OSRM demo (FOSSGIS as its fallback) —
    // one request per host per refresh keeps both under their per-IP limits.
    const urls = profile === "car" ? [fallbackCarTableUrl(coords), osrmTableUrl("car", coords)] : [osrmTableUrl("foot", coords)];
    let lastErr: unknown = new Error("router backing off");
    for (const url of urls) {
      if (isFossgis(url) && Date.now() < this.blockedUntil) continue;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.deps.timeoutMs ?? TABLE_TIMEOUT_MS);
      try {
        const res = await this.fetchFn(url, { signal: ctl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseOsrmTable(await res.json());
      } catch (e) {
        lastErr = e;
        if (isFossgis(url)) this.blockedUntil = Date.now() + OSRM_BACKOFF_MS;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  private cacheGet(coords: string): { walk: DurationMatrix; drive: DurationMatrix } | null {
    try {
      const raw = this.deps.storage?.getItem(CACHE_PREFIX + coords);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!Array.isArray(v?.walk) || !Array.isArray(v?.drive)) return null;
      return v;
    } catch {
      return null;
    }
  }

  private cacheSet(coords: string, walk: DurationMatrix, drive: DurationMatrix): void {
    try {
      this.deps.storage?.setItem(CACHE_PREFIX + coords, JSON.stringify({ walk, drive }));
    } catch {
      /* best effort */
    }
  }
}
