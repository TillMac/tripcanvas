// Pure, deterministic place-validation gates (negative-space binary assertions).
// Ported reduced to the two kept gates: resolve-success (a0) + excluded-type (a1)
// (T2: Overpass, opening-hours, business-status and advisory gates not ported).
// PURE logic only — the search dependency is INJECTED; no network I/O here.
//
// Cross-cutting rules:
//  1. Three-state: PASS / FAIL / UNKNOWN. UNKNOWN is never PASS.
//  2. Source discipline: every judgment reads injected service fields, never AI free-text.
//  3. Loggable: each assertion returns { id, placeId?, outcome, reason }.

export type Outcome = "PASS" | "FAIL" | "UNKNOWN";

export interface AssertionResult {
  id: string;
  placeId?: string;
  outcome: Outcome;
  reason: string;
}

export interface ResolvedPlace {
  placeId: string;
  name: string;
  /** Service-provided category vocabulary (e.g. Nominatim class/type). A1 reads this. */
  types?: string[];
  lat?: number;
  lng?: number;
  city?: string;
  region?: string;
  country?: string;
  /** Full human location string (e.g. Nominatim display_name "POI, ward, Tokyo, Japan").
   *  Used for robust context matching — the structured city field is often a ward, not the prefecture. */
  locationText?: string;
}

export interface TripGeoContext {
  city?: string;
  region?: string;
  country?: string;
}

/** A search candidate carries the same service fields as a ResolvedPlace. */
export type PlaceCandidate = ResolvedPlace;

/** Injected place-search dependency. Throws on service error/timeout (→ A0 UNKNOWN). */
export type SearchFn = (name: string, ctx: TripGeoContext) => Promise<PlaceCandidate[]>;

// ── helpers ────────────────────────────────────────────────────────────────

function ctxStr(ctx: TripGeoContext): string {
  return [ctx.city, ctx.region, ctx.country].filter(Boolean).join("/");
}

/** Does a candidate match the context? Every provided context term must appear somewhere in the
 *  candidate's location text. We match against a haystack of name + city/region/country + the full
 *  locationText (display_name), because the structured `city` is often a ward (e.g. "Taito"), not the
 *  prefecture the user named (e.g. "Tokyo") — the prefecture lives in display_name. */
function inContext(c: PlaceCandidate, ctx: TripGeoContext): boolean {
  const terms = [ctx.city, ctx.region, ctx.country].filter((x): x is string => !!x);
  if (terms.length === 0) return true;
  const hay = [c.name, c.city, c.region, c.country, c.locationText]
    .filter((x): x is string => !!x)
    .join(" ")
    .toLowerCase();
  return terms.every((t) => hay.includes(t.trim().toLowerCase()));
}

// ── A0: resolve + disambiguate ──────────────────────────────────────────────
// Guards against (a) hallucinated places (zero results) and (b) same-name-different-place.
export async function a0_resolve(
  name: string,
  ctx: TripGeoContext,
  search: SearchFn,
): Promise<{ result: AssertionResult; place?: ResolvedPlace }> {
  const id = "a0_resolve";
  let results: PlaceCandidate[];
  try {
    results = await search(name, ctx);
  } catch (err) {
    return {
      result: { id, outcome: "UNKNOWN", reason: `search service error: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
  if (!Array.isArray(results) || results.length === 0) {
    return { result: { id, outcome: "FAIL", reason: `zero results for "${name}" — likely a hallucinated place` } };
  }

  const hasCtx = !!(ctx.city || ctx.region || ctx.country);
  if (hasCtx) {
    const inCtx = results.filter((c) => inContext(c, ctx));
    if (inCtx.length === 0) {
      return { result: { id, outcome: "FAIL", reason: `no candidate within target context (${ctxStr(ctx)})` } };
    }
    // Results are importance-ranked; multiple in-context hits are usually the same place as several
    // OSM objects (node/way/relation) — take the top-ranked. Cross-region homonyms are already
    // filtered out by inContext, and zero-result hallucinations failed above.
    const place = inCtx[0];
    return {
      result: {
        id,
        placeId: place.placeId,
        outcome: "PASS",
        reason: inCtx.length === 1 ? "resolved to one place in target context" : `resolved to top of ${inCtx.length} in-context candidates`,
      },
      place,
    };
  }

  // No geo context to disambiguate with.
  if (results.length === 1) {
    const place = results[0];
    return { result: { id, placeId: place.placeId, outcome: "PASS", reason: "single unambiguous result" }, place };
  }
  return { result: { id, outcome: "FAIL", reason: `${results.length} results across regions, no context to disambiguate (same-name risk)` } };
}

// ── A1: excluded type ───────────────────────────────────────────────────────
export function a1_excludedType(place: ResolvedPlace, excludedTypes: string[]): AssertionResult {
  const id = "a1_excludedType";
  if (place.types == null) {
    return { id, placeId: place.placeId, outcome: "UNKNOWN", reason: "place.types missing from service" };
  }
  const excluded = new Set(excludedTypes.map((t) => t.toLowerCase()));
  const hits = place.types.filter((t) => excluded.has(t.toLowerCase()));
  if (hits.length === 0) {
    return { id, placeId: place.placeId, outcome: "PASS", reason: "no excluded type matched" };
  }
  return { id, placeId: place.placeId, outcome: "FAIL", reason: `matched excluded type(s): ${hits.join(", ")}` };
}
