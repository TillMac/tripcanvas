import { haversineKm, type LatLng } from "./geo.js";
import { estimateMinutes } from "./geo.js";

export interface InsertResult {
  afterIndex: number;        // 插在第幾個之後（0=最前，n=最後）
  detourMin: number;
  beforeId: string | null;
  afterId: string | null;
}

export function computeBestInsertion(
  dayPlaces: { id: string; lat: number; lng: number }[],
  cand: LatLng,
): InsertResult {
  const n = dayPlaces.length;
  if (n === 0) return { afterIndex: 0, detourMin: 0, beforeId: null, afterId: null };

  let best: InsertResult | null = null;
  let bestKm = Infinity;
  for (let k = 0; k <= n; k++) {
    const before = k > 0 ? dayPlaces[k - 1] : null;
    const after = k < n ? dayPlaces[k] : null;
    let km: number;
    if (before && after) km = haversineKm(before, cand) + haversineKm(cand, after) - haversineKm(before, after);
    else if (after) km = haversineKm(cand, after);
    else km = haversineKm(before!, cand);
    if (km < bestKm) {
      bestKm = km;
      best = { afterIndex: k, detourMin: estimateMinutes(km), beforeId: before?.id ?? null, afterId: after?.id ?? null };
    }
  }
  return best!;
}
