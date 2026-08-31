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

export interface MatrixDeps {
  fetchFn?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem">;
  debounceMs?: number;
}

export class MatrixService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private fetchFn: typeof fetch;

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
    if (placedHash(s) === s.matrices.forHash && !s.matrices.stale) return;
    await (this.inflight ?? this.refresh());
    // A newer commit may have changed the set while the fetch ran.
    const s2 = this.store.getState();
    if (placedHash(s2) !== s2.matrices.forHash) await this.refresh();
  }

  /** Fetch walk+drive tables for an explicit place set (plan_trip §3 step 4,
   *  BEFORE grouping) and seed the per-hash cache so the post-commit refresh
   *  is instant. Returns null on failure (caller falls back to estimates). */
  async fetchTablesFor(
    places: { id: string; lat: number; lon: number }[],
  ): Promise<{ walk: DurationMatrix; drive: DurationMatrix; ids: string[] } | null> {
    const ids = places.map((p) => p.id).sort();
    const hash = ids.join(";");
    const byId = new Map(places.map((p) => [p.id, p]));
    const cached = this.cacheGet(hash);
    if (cached) return { ...cached, ids };
    const coords = ids.map((pid) => `${byId.get(pid)!.lon},${byId.get(pid)!.lat}`).join(";");
    try {
      const [walk, drive] = await Promise.all([this.fetchTable("foot", coords), this.fetchTable("car", coords)]);
      this.cacheSet(hash, walk, drive);
      return { walk, drive, ids };
    } catch {
      return null;
    }
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

    const cached = this.cacheGet(hash);
    if (cached) {
      this.store.setState({ matrices: { walk: cached.walk, drive: cached.drive, ids, forHash: hash, stale: false } });
      return;
    }

    const coords = ids.map((pid) => `${s.places[pid].lon},${s.places[pid].lat}`).join(";");
    try {
      const [walk, drive] = await Promise.all([
        this.fetchTable("foot", coords),
        this.fetchTable("car", coords),
      ]);
      this.store.setState({ matrices: { walk, drive, ids, forHash: hash, stale: false } });
      this.cacheSet(hash, walk, drive);
    } catch {
      // Keep the old matrix (covered pairs still real); schedule falls back to
      // estimates for uncovered pairs; page stays editable (ADR-0001).
      const cur = this.store.getState().matrices;
      this.store.setState({ matrices: { ...cur, stale: true } });
    }
  }

  private async fetchTable(profile: "foot" | "car", coords: string): Promise<DurationMatrix> {
    const res = await this.fetchFn(osrmTableUrl(profile, coords));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseOsrmTable(await res.json());
  }

  private cacheGet(hash: string): { walk: DurationMatrix; drive: DurationMatrix } | null {
    try {
      const raw = this.deps.storage?.getItem(CACHE_PREFIX + hash);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!Array.isArray(v?.walk) || !Array.isArray(v?.drive)) return null;
      return v;
    } catch {
      return null;
    }
  }

  private cacheSet(hash: string, walk: DurationMatrix, drive: DurationMatrix): void {
    try {
      this.deps.storage?.setItem(CACHE_PREFIX + hash, JSON.stringify({ walk, drive }));
    } catch {
      /* best effort */
    }
  }
}
