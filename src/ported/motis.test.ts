import { describe, it, expect } from "vitest";
import { motisPlanUrl, parseMotisItinerary, withDestinationName } from "./motis.js";
import type { TransitLeg } from "./motis.js";

const sample = {
  itineraries: [{
    duration: 3720, transfers: 1,
    legs: [
      { mode: "WALK", from: { name: "START", lat: 35.715, lon: 139.774 }, to: { name: "Ueno", lat: 35.7118, lon: 139.7761 }, duration: 540 },
      { mode: "SUBWAY", from: { name: "Ueno", lat: 35.7118, lon: 139.7761 }, to: { name: "Ginza", lat: 35.6715, lon: 139.7654 }, duration: 780, routeShortName: "G", routeColor: "ff9500", headsign: "Shibuya", intermediateStops: [{ name: "Kanda", lat: 35.6937, lon: 139.7709 }] },
    ],
  }],
};

describe("parseMotisItinerary", () => {
  it("splits total/transfers/steps", () => {
    const r = parseMotisItinerary(sample)!;
    expect(r.totalMin).toBe(62);
    expect(r.transfers).toBe(1);
    expect(r.steps).toHaveLength(2);
  });
  it("WALK becomes walk step (no line/color)", () => {
    const r = parseMotisItinerary(sample)!;
    expect(r.steps[0].mode).toBe("walk");
    expect(r.steps[0].line).toBeNull();
  });
  it("ride step carries line/color/headsign + coords (from+intermediate+to)", () => {
    const r = parseMotisItinerary(sample)!;
    const s = r.steps[1];
    expect(s.mode).toBe("transit");
    expect(s.line).toBe("G");
    expect(s.color).toBe("ff9500");
    expect(s.coords).toEqual([[35.7118,139.7761],[35.6937,139.7709],[35.6715,139.7654]]);
  });
  it("line prefers routeLongName, falls back to routeShortName", () => {
    const mk = (routeShortName: string, routeLongName: string) => ({
      itineraries: [{ duration: 600, legs: [{ mode: "SUBWAY", duration: 600, from: {}, to: {}, routeShortName, routeLongName }] }],
    });
    expect(parseMotisItinerary(mk("Z", "Tokyo Metro Hanzomon Line"))!.steps[0].line).toBe("Tokyo Metro Hanzomon Line");
    expect(parseMotisItinerary(mk("Asakusa Line", ""))!.steps[0].line).toBe("Asakusa Line");
    expect(parseMotisItinerary(mk("", ""))!.steps[0].line).toBeNull();
  });
  it("no itineraries -> null", () => {
    expect(parseMotisItinerary({ itineraries: [] })).toBeNull();
  });
});

describe("withDestinationName", () => {
  const mk = (lastToName: string): TransitLeg => ({
    totalMin: 30,
    transfers: 0,
    steps: [
      { mode: "walk", line: null, color: null, headsign: null, durationMin: 5, fromName: "A", toName: "Ueno", coords: [] },
      { mode: "transit", line: "G", color: "ff9500", headsign: "Shibuya", durationMin: 20, fromName: "Ueno", toName: "Ginza", coords: [] },
      { mode: "walk", line: null, color: null, headsign: null, durationMin: 5, fromName: "Ginza", toName: lastToName, coords: [] },
    ],
  });

  it("END -> destination name, intermediate stops untouched", () => {
    const r = withDestinationName(mk("END"), "Odaiba Seaside Park")!;
    expect(r.steps[2].toName).toBe("Odaiba Seaside Park");
    expect(r.steps[0].toName).toBe("Ueno");
    expect(r.steps[1].toName).toBe("Ginza");
  });
  it("blank toName is replaced too", () => {
    const r = withDestinationName(mk("  "), "Destination")!;
    expect(r.steps[2].toName).toBe("Destination");
  });
  it("real station name kept", () => {
    const r = withDestinationName(mk("Actual Sta"), "Destination")!;
    expect(r.steps[2].toName).toBe("Actual Sta");
  });
  it("null leg -> null; empty steps -> unchanged", () => {
    expect(withDestinationName(null, "x")).toBeNull();
    const empty: TransitLeg = { totalMin: 0, transfers: 0, steps: [] };
    expect(withDestinationName(empty, "x")).toBe(empty);
  });
});

describe("motisPlanUrl", () => {
  it("builds URL with the ,0 level suffix on both coordinates", () => {
    const u = motisPlanUrl(35.71, 139.77, 35.62, 139.79, "2026-06-10T01:00:00Z");
    expect(u).toContain("fromPlace=35.71,139.77,0&");
    expect(u).toContain("toPlace=35.62,139.79,0&");
    expect(u).toContain("api.transitous.org");
    expect(u.endsWith("&language=en")).toBe(true);
  });
});
