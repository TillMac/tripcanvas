export type StepMode = "walk" | "transit";
export interface TransitStep {
  mode: StepMode; line: string | null; color: string | null; headsign: string | null;
  durationMin: number; fromName: string; toName: string; coords: [number, number][];
}
export interface TransitLeg { totalMin: number; transfers: number; steps: TransitStep[] }

// Coordinates carry a ",0" level suffix — required by the MOTIS API since the
// port source was written (T2 acceptance criterion, verified 2026-08-31).
// &language=en makes GTFS stop/route/headsign names come back in English
// (verified live 2026-09-04: "渋谷 Shibuya" -> "Shibuya").
export function motisPlanUrl(fromLat: number, fromLng: number, toLat: number, toLng: number, timeISO: string): string {
  return `https://api.transitous.org/api/v1/plan?fromPlace=${fromLat},${fromLng},0&toPlace=${toLat},${toLng},0&time=${encodeURIComponent(timeISO)}&language=en`;
}

export function parseMotisItinerary(res: unknown): TransitLeg | null {
  const it = (res as { itineraries?: any[] })?.itineraries?.[0];
  if (!it || typeof it.duration !== "number") return null;
  const steps: TransitStep[] = (it.legs ?? []).map((leg: any) => {
    const isWalk = leg.mode === "WALK";
    const coords: [number, number][] = [];
    if (typeof leg.from?.lat === "number") coords.push([leg.from.lat, leg.from.lon]);
    for (const s of leg.intermediateStops ?? []) if (typeof s.lat === "number") coords.push([s.lat, s.lon]);
    if (typeof leg.to?.lat === "number") coords.push([leg.to.lat, leg.to.lon]);
    return {
      mode: isWalk ? "walk" : "transit",
      line: isWalk ? null : (leg.routeLongName || leg.routeShortName || null),
      color: isWalk ? null : (leg.routeColor ?? null),
      headsign: isWalk ? null : (leg.headsign ?? null),
      durationMin: Math.round((leg.duration ?? 0) / 60),
      fromName: leg.from?.name ?? "", toName: leg.to?.name ?? "",
      coords,
    };
  });
  return { totalMin: Math.round(it.duration / 60), transfers: it.transfers ?? 0, steps };
}

/**
 * MOTIS labels the final arrival "END" (or leaves it blank). Replace the last
 * step's toName with the actual destination name so both the map and the
 * handback read naturally. Returns a new leg; leaves intermediate steps intact.
 */
export function withDestinationName(
  leg: TransitLeg | null,
  destName: string,
): TransitLeg | null {
  if (!leg || leg.steps.length === 0) return leg;
  const lastIdx = leg.steps.length - 1;
  const last = leg.steps[lastIdx];
  if (last.toName !== "END" && last.toName.trim() !== "") return leg;
  const steps = leg.steps.map((s, i) =>
    i === lastIdx ? { ...s, toName: destName } : s,
  );
  return { ...leg, steps };
}
