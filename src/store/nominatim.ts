// One app-wide Nominatim queue (ADR-0001, policy: ≥1.1s spacing, email param,
// normalized-query geocache, single thread) shared by the human search box and
// every tool. Gates per name: resolve-success (a0) + excluded-type (a1);
// failures are reported, never fatal. All I/O injectable for tests.
import { nominatimSearchUrl, parseNominatim } from "../ported/geocode.js";
import { a0_resolve, a1_excludedType, type PlaceCandidate } from "../ported/place-assert.js";

export const NOMINATIM_EMAIL = "tillmac.sun@gmail.com";
/** Switchable without a client update path change: swap this constant. */
export const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org";
export const MIN_SPACING_MS = 1100;
export const FETCH_TIMEOUT_MS = 8000;
const GEOCACHE_KEY = "tripcanvas:geocache:v1";

/** Whole-area categories a stop can never be (the "'Tokyo' is a city" gate). */
export const EXCLUDED_TYPES = [
  "boundary", "administrative", "place", "city", "town", "state", "province",
  "country", "county", "municipality", "region", "island", "archipelago",
];

export type ResolveResult =
  | { ok: true; place: PlaceCandidate; cached: boolean }
  | { ok: false; kind: "none" | "excluded" | "error" | "deadline"; message: string };

/** The one PlaceCandidate -> store PlaceInput conversion (used by tools + UI). */
export function toPlaceInput(place: PlaceCandidate, query: string): { name: string; lat: number; lon: number; query: string } {
  return { name: place.name, lat: place.lat!, lon: place.lng!, query };
}

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface NominatimDeps {
  fetchFn?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem">;
  minSpacingMs?: number;
  fetchTimeoutMs?: number;
}

export class NominatimQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = -Infinity;
  private cache: Record<string, PlaceCandidate> | null = null;
  private fetchFn: typeof fetch;
  private storage?: Pick<Storage, "getItem" | "setItem">;
  private spacing: number;
  private timeoutMs: number;

  constructor(deps: NominatimDeps = {}) {
    this.fetchFn = deps.fetchFn ?? ((...a) => fetch(...a));
    this.storage = deps.storage;
    this.spacing = deps.minSpacingMs ?? MIN_SPACING_MS;
    this.timeoutMs = deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  }

  /** Cache lookup only — 0s, no queue slot. */
  cached(query: string): PlaceCandidate | null {
    return this.loadCache()[normalizeQuery(query)] ?? null;
  }

  /** Number of uncached names in a list (for plan_trip's cap math). */
  uncachedCount(queries: string[]): number {
    const seen = new Set<string>();
    for (const q of queries) {
      const n = normalizeQuery(q);
      if (!this.loadCache()[n]) seen.add(n);
    }
    return seen.size;
  }

  /**
   * Resolve one free-text name. Serial through the app-wide queue; a geocache
   * hit returns immediately without a queue slot. `deadline` (epoch ms) is
   * checked before every request and every retry (plan_trip's 22s wall clock).
   */
  resolve(query: string, opts: { deadline?: number } = {}): Promise<ResolveResult> {
    const norm = normalizeQuery(query);
    const hit = this.loadCache()[norm];
    if (hit) return Promise.resolve({ ok: true, place: hit, cached: true });
    const run = this.chain.then(() => this.doResolve(query, norm, opts.deadline));
    this.chain = run.catch(() => {});
    return run;
  }

  private async doResolve(query: string, norm: string, deadline?: number): Promise<ResolveResult> {
    // A queued name may have been cached while it waited.
    const hit = this.loadCache()[norm];
    if (hit) return { ok: true, place: hit, cached: true };
    // Per-request budget: the fetch timeout, capped so no request outlives the deadline.
    const budget = () => (deadline === undefined ? this.timeoutMs : Math.min(this.timeoutMs, deadline - Date.now()));
    const timeLimit = (): ResolveResult => ({ ok: false, kind: "deadline", message: `not resolved (time limit): '${query}'` });
    const wait = this.lastAt + this.spacing - Date.now();
    if (wait > 0) await sleep(wait);
    // Checked AFTER the spacing sleep: a request that would start past the deadline is never sent.
    if (budget() <= 0) return timeLimit();

    let raw: unknown;
    try {
      raw = await this.fetchOnce(query, budget());
    } catch (err) {
      if (budget() <= 0) return timeLimit();
      // A timed-out query is slow, not flaky: re-sending it only doubles the cost.
      if ((err as { name?: string })?.name === "AbortError") {
        return { ok: false, kind: "error", message: `search timed out for '${query}' — try again.` };
      }
      try {
        raw = await this.fetchOnce(query, budget()); // one retry for network/HTTP errors
      } catch {
        return { ok: false, kind: "error", message: `search service unreachable for '${query}' — try again.` };
      }
    }

    const candidates = parseNominatim(raw);
    const { result, place } = await a0_resolve(query, {}, async () => candidates);
    if (result.outcome !== "PASS" || !place) {
      return { ok: false, kind: "none", message: `no place found for '${query}' — add a city or landmark to the name.` };
    }
    const a1 = a1_excludedType(place, EXCLUDED_TYPES);
    if (a1.outcome === "FAIL") {
      return { ok: false, kind: "excluded", message: `'${query}' resolved to a whole area (${place.name}) — name a venue.` };
    }
    this.cacheSet(norm, place);
    return { ok: true, place, cached: false };
  }

  private async fetchOnce(query: string, timeoutMs: number): Promise<unknown> {
    this.lastAt = Date.now();
    const url =
      nominatimSearchUrl(query, { limit: 1 }).replace("https://nominatim.openstreetmap.org", NOMINATIM_ENDPOINT) +
      `&email=${encodeURIComponent(NOMINATIM_EMAIL)}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private loadCache(): Record<string, PlaceCandidate> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(this.storage?.getItem(GEOCACHE_KEY) ?? "{}") ?? {};
    } catch {
      this.cache = {};
    }
    return this.cache!;
  }

  private cacheSet(norm: string, place: PlaceCandidate): void {
    const c = this.loadCache();
    c[norm] = place;
    try {
      this.storage?.setItem(GEOCACHE_KEY, JSON.stringify(c));
    } catch {
      /* storage full/blocked — cache stays in-memory */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
