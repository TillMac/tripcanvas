export type DurationMatrix = (number | null)[][];

/**
 * Parse an OSRM Table API response into a DurationMatrix.
 * - Throws if code !== "Ok" or durations is missing.
 * - Preserves null values for unreachable pairs.
 */
export function parseOsrmTable(res: unknown): DurationMatrix {
  if (typeof res !== "object" || res === null) {
    throw new Error("OSRM response is not an object");
  }
  const r = res as Record<string, unknown>;
  if (r["code"] !== "Ok") {
    throw new Error(`OSRM error: code=${String(r["code"])} message=${String(r["message"] ?? "")}`);
  }
  if (!Array.isArray(r["durations"])) {
    throw new Error("OSRM response missing durations array");
  }
  return r["durations"] as DurationMatrix;
}

/**
 * Build the OSRM Table API URL for the given profile and semicolon-separated
 * lon,lat coordinate string.
 *
 * Profile mapping:
 *   "foot" → routed-foot service, /table/v1/foot/
 *   "car"  → routed-car  service, /table/v1/car/
 */
export function osrmTableUrl(profile: "foot" | "car", coords: string): string {
  const service = profile === "foot" ? "routed-foot" : "routed-car";
  return `https://routing.openstreetmap.de/${service}/table/v1/${profile}/${coords}?annotations=duration`;
}

/**
 * Build the OSRM Route API URL for the given profile and semicolon-separated
 * lon,lat coordinate string. Returns GeoJSON geometry with full overview.
 *
 * Profile mapping:
 *   "foot" → routed-foot service, /route/v1/foot/
 *   "car"  → routed-car  service, /route/v1/car/
 */
export function osrmRouteUrl(profile: "foot" | "car", coords: string): string {
  const service = profile === "foot" ? "routed-foot" : "routed-car";
  return `https://routing.openstreetmap.de/${service}/route/v1/${profile}/${coords}?overview=full&geometries=geojson`;
}

/**
 * Parse an OSRM Route API response into a coordinate array ([lng, lat] pairs).
 * - Returns coordinates array when code === "Ok" and routes[0].geometry.coordinates exists.
 * - Returns null on any other case (non-Ok code, missing routes, missing geometry, bad input).
 *   Callers should fall back to a straight-line segment on null.
 */
export function parseOsrmRoute(res: unknown): [number, number][] | null {
  if (typeof res !== "object" || res === null) return null;
  const r = res as Record<string, unknown>;
  if (r["code"] !== "Ok") return null;
  if (!Array.isArray(r["routes"]) || r["routes"].length === 0) return null;
  const route = r["routes"][0] as Record<string, unknown>;
  if (typeof route !== "object" || route === null) return null;
  const geometry = route["geometry"] as Record<string, unknown> | undefined;
  if (!geometry || !Array.isArray(geometry["coordinates"])) return null;
  return geometry["coordinates"] as [number, number][];
}
