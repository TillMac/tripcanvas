import { describe, it, expect } from "vitest";
import { haversineKm, estimateMinutes } from "./geo.js";

describe("geo", () => {
  it("haversineKm 約略正確（上野→晴空塔 ~3.6km）", () => {
    const d = haversineKm({ lat: 35.715, lng: 139.774 }, { lat: 35.710, lng: 139.811 });
    expect(d).toBeGreaterThan(3); expect(d).toBeLessThan(4.5);
  });
  it("同點為 0", () => {
    expect(haversineKm({ lat: 35.7, lng: 139.7 }, { lat: 35.7, lng: 139.7 })).toBeCloseTo(0, 5);
  });
  it("estimateMinutes：5km/h → 6km≈72分", () => {
    expect(estimateMinutes(6)).toBe(72);
  });
});
