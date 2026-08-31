import { describe, it, expect } from "vitest";
import { parseOsrmTable, osrmTableUrl, osrmRouteUrl, parseOsrmRoute } from "./osrm.js";

// Minimal OSRM Table API response shape
const makeOkResponse = (durations: (number | null)[][]) => ({
  code: "Ok",
  durations,
});

describe("parseOsrmTable", () => {
  it("returns duration matrix on Ok response", () => {
    const res = makeOkResponse([
      [0, 120, 300],
      [118, 0, 200],
      [298, 198, 0],
    ]);
    const matrix = parseOsrmTable(res);
    expect(matrix).toEqual([
      [0, 120, 300],
      [118, 0, 200],
      [298, 198, 0],
    ]);
  });

  it("preserves null (unreachable) values from OSRM", () => {
    const res = makeOkResponse([
      [0, null],
      [null, 0],
    ]);
    const matrix = parseOsrmTable(res);
    expect(matrix[0][1]).toBeNull();
    expect(matrix[1][0]).toBeNull();
  });

  it("throws when code is not Ok", () => {
    const res = { code: "NoRoute", message: "No route found" };
    expect(() => parseOsrmTable(res)).toThrow();
  });

  it("throws when durations is missing", () => {
    const res = { code: "Ok" };
    expect(() => parseOsrmTable(res)).toThrow();
  });
});

describe("osrmTableUrl", () => {
  it("builds foot URL with routed-foot profile", () => {
    const url = osrmTableUrl("foot", "139.7967,35.7148;139.8107,35.7101");
    expect(url).toBe(
      "https://routing.openstreetmap.de/routed-foot/table/v1/foot/139.7967,35.7148;139.8107,35.7101?annotations=duration"
    );
  });

  it("builds car URL with routed-car profile", () => {
    const url = osrmTableUrl("car", "139.7967,35.7148;139.8107,35.7101");
    expect(url).toBe(
      "https://routing.openstreetmap.de/routed-car/table/v1/car/139.7967,35.7148;139.8107,35.7101?annotations=duration"
    );
  });
});

describe("osrmRouteUrl", () => {
  it("builds foot route URL with routed-foot profile", () => {
    const url = osrmRouteUrl("foot", "139.7967,35.7148;139.8107,35.7101");
    expect(url).toBe(
      "https://routing.openstreetmap.de/routed-foot/route/v1/foot/139.7967,35.7148;139.8107,35.7101?overview=full&geometries=geojson"
    );
  });

  it("builds car route URL with routed-car profile", () => {
    const url = osrmRouteUrl("car", "139.7967,35.7148;139.8107,35.7101");
    expect(url).toBe(
      "https://routing.openstreetmap.de/routed-car/route/v1/car/139.7967,35.7148;139.8107,35.7101?overview=full&geometries=geojson"
    );
  });
});

describe("parseOsrmRoute", () => {
  const coords: [number, number][] = [
    [139.7967, 35.7148],
    [139.8007, 35.718],
    [139.8107, 35.7101],
  ];

  it("returns coordinates array on Ok response with valid geometry", () => {
    const res = {
      code: "Ok",
      routes: [
        { geometry: { type: "LineString", coordinates: coords } },
      ],
    };
    const result = parseOsrmRoute(res);
    expect(result).toEqual(coords);
  });

  it("returns null when code is not Ok", () => {
    const res = { code: "NoRoute", routes: [] };
    expect(parseOsrmRoute(res)).toBeNull();
  });

  it("returns null when routes array is empty", () => {
    const res = { code: "Ok", routes: [] };
    expect(parseOsrmRoute(res)).toBeNull();
  });

  it("returns null when geometry coordinates is missing", () => {
    const res = { code: "Ok", routes: [{ geometry: {} }] };
    expect(parseOsrmRoute(res)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseOsrmRoute(null)).toBeNull();
    expect(parseOsrmRoute("bad")).toBeNull();
  });
});
