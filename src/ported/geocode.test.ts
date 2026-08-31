import { describe, it, expect } from "vitest";
import { nominatimSearchUrl, parseNominatim } from "./geocode.js";

const sample = [
  {
    osm_type: "way", osm_id: 173154847,
    lat: "35.7148", lon: "139.7967",
    class: "tourism", type: "attraction",
    display_name: "Senso-ji, Asakusa, Taito, Tokyo, Japan",
    address: { city: "Tokyo", state: "Tokyo", country: "Japan" },
    namedetails: { name: "Sensō-ji" },
  },
];

describe("nominatimSearchUrl", () => {
  it("builds URL, URL-encodes query, includes addressdetails/namedetails/accept-language", () => {
    const u = nominatimSearchUrl("Senso-ji");
    expect(u).toContain("nominatim.openstreetmap.org/search");
    expect(u).toContain("q=Senso-ji");
    expect(u).toContain("format=jsonv2");
    expect(u).toContain("addressdetails=1");
    expect(u).toContain("namedetails=1");
    expect(u).toContain("accept-language=en");
  });
});

describe("parseNominatim", () => {
  it("extracts placeId/name/types/coords/city/country", () => {
    const [p] = parseNominatim(sample);
    expect(p.placeId).toBe("way/173154847");
    expect(p.name).toBe("Sensō-ji");
    expect(p.types).toEqual(["tourism", "attraction"]);
    expect(p.lat).toBeCloseTo(35.7148);
    expect(p.lng).toBeCloseTo(139.7967);
    expect(p.city).toBe("Tokyo");
    expect(p.country).toBe("Japan");
    expect(p.locationText).toBe("Senso-ji, Asakusa, Taito, Tokyo, Japan");
  });
  it("non-array -> []", () => {
    expect(parseNominatim({})).toEqual([]);
    expect(parseNominatim(null)).toEqual([]);
  });
  it("entries missing lat/lon are skipped", () => {
    expect(parseNominatim([{ osm_type: "node", osm_id: 1, class: "x", type: "y" }])).toEqual([]);
  });
});
