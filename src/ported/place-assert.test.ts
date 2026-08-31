import { describe, it, expect } from "vitest";
import {
  a0_resolve,
  a1_excludedType,
  type PlaceCandidate,
} from "./place-assert.js";

describe("A0 resolve / disambiguate", () => {
  it("hallucinated place with zero results -> FAIL", async () => {
    const { result, place } = await a0_resolve("Nonexistent Fantasy Spot", { city: "Tokyo" }, async () => []);
    expect(result.outcome).toBe("FAIL");
    expect(place).toBeUndefined();
  });

  it("same name, different cities, no context -> FAIL", async () => {
    const cands: PlaceCandidate[] = [
      { placeId: "a", name: "Chelsea", city: "London", country: "UK" },
      { placeId: "b", name: "Chelsea", city: "New York", country: "USA" },
    ];
    const { result } = await a0_resolve("Chelsea", {}, async () => cands);
    expect(result.outcome).toBe("FAIL");
  });

  it("search service timeout -> UNKNOWN (never PASS)", async () => {
    const { result } = await a0_resolve("Ueno Park", { city: "Tokyo" }, async () => {
      throw new Error("timeout");
    });
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.outcome).not.toBe("PASS");
  });

  it("single in-context result -> PASS (returns the place)", async () => {
    const cand: PlaceCandidate = { placeId: "p1", name: "Ueno Park", city: "Tokyo", country: "Japan" };
    const { result, place } = await a0_resolve("Ueno Park", { city: "Tokyo" }, async () => [cand]);
    expect(result.outcome).toBe("PASS");
    expect(place?.placeId).toBe("p1");
  });

  // Regression (live dry-run bug): Nominatim's structured city is the WARD ("Taito"), the prefecture
  // ("Tokyo") only lives in display_name -> must match via locationText, not the city field.
  it("city context vs ward-level city: matches via locationText -> PASS", async () => {
    const cand: PlaceCandidate = {
      placeId: "way/1", name: "Ueno Park", city: "Taito", country: "Japan",
      locationText: "Ueno Park, Taito, Tokyo, 110-0007, Japan", lat: 35.7148, lng: 139.7745,
    };
    const { result, place } = await a0_resolve("Ueno Park", { city: "Tokyo", country: "Japan" }, async () => [cand]);
    expect(result.outcome).toBe("PASS");
    expect(place?.placeId).toBe("way/1");
  });

  it("cross-city homonym (Osaka) filtered by context -> FAIL", async () => {
    const cands: PlaceCandidate[] = [
      { placeId: "osaka", name: "Ueno Park", city: "Osaka", country: "Japan", locationText: "Ueno Park, Osaka, Japan" },
    ];
    const { result } = await a0_resolve("Ueno Park", { city: "Tokyo", country: "Japan" }, async () => cands);
    expect(result.outcome).toBe("FAIL");
  });

  it("same place as multiple OSM objects (all in context) -> PASS, top-ranked wins", async () => {
    const cands: PlaceCandidate[] = [
      { placeId: "way/1", name: "Ueno Park", city: "Taito", country: "Japan", locationText: "Ueno Park, Taito, Tokyo, Japan" },
      { placeId: "relation/2", name: "Ueno Park", city: "Taito", country: "Japan", locationText: "Ueno Park, Taito, Tokyo, Japan" },
    ];
    const { result, place } = await a0_resolve("Ueno Park", { city: "Tokyo", country: "Japan" }, async () => cands);
    expect(result.outcome).toBe("PASS");
    expect(place?.placeId).toBe("way/1");
  });
});

describe("A1 excluded type", () => {
  it("excluded 'museum' recommended anyway -> FAIL", () => {
    const r = a1_excludedType({ placeId: "m", name: "Some Museum", types: ["museum", "tourist_attraction"] }, ["museum"]);
    expect(r.outcome).toBe("FAIL");
    expect(r.reason).toContain("museum");
  });
  it("no hit -> PASS", () => {
    expect(a1_excludedType({ placeId: "p", name: "Park", types: ["park"] }, ["museum"]).outcome).toBe("PASS");
  });
  it("types missing -> UNKNOWN", () => {
    expect(a1_excludedType({ placeId: "p", name: "X" }, ["museum"]).outcome).toBe("UNKNOWN");
  });
});
