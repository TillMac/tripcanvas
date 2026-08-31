// geocode.ts — Nominatim search URL builder + response parser.
// Ported without opening-hours support (T2: opening-hours code not ported).
import type { PlaceCandidate } from "./place-assert.js";

export function nominatimSearchUrl(query: string, opts?: { limit?: number }): string {
  const limit = opts?.limit ?? 5;
  // accept-language=en so address/display_name come back in English (matches the
  // English queries the page sends; Japanese-default fields wouldn't match "Tokyo").
  return `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=${limit}&addressdetails=1&namedetails=1&accept-language=en`;
}

export function parseNominatim(res: unknown): PlaceCandidate[] {
  if (!Array.isArray(res)) return [];
  const out: PlaceCandidate[] = [];
  for (const item of res) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const lat = Number(r["lat"]);
    const lng = Number(r["lon"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const addr = (r["address"] ?? {}) as Record<string, string>;
    const namedetails = (r["namedetails"] ?? {}) as Record<string, string>;
    const cls = typeof r["class"] === "string" ? (r["class"] as string) : undefined;
    const typ = typeof r["type"] === "string" ? (r["type"] as string) : undefined;
    const types = [cls, typ].filter((x): x is string => !!x);
    const displayName = typeof r["display_name"] === "string" ? (r["display_name"] as string) : "";
    out.push({
      placeId: `${r["osm_type"] ?? "?"}/${r["osm_id"] ?? "?"}`,
      name: namedetails["name"] ?? displayName.split(",")[0] ?? "",
      types: types.length ? types : undefined,
      lat,
      lng,
      city: addr["city"] ?? addr["town"] ?? addr["village"] ?? addr["suburb"],
      region: addr["state"],
      country: addr["country"],
      locationText: displayName || undefined,
    });
  }
  return out;
}
