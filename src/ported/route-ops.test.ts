import { describe, it, expect } from "vitest";
import { validatePlaces } from "./route-schemas.js";
import { legSeconds, dayTotalSeconds, isUnreasonable } from "./route-ops.js";

const matrix = { walk: [[0, 720, 2520], [720, 0, 600], [2520, 600, 0]], drive: [[0, 300, 600], [300, 0, 240], [600, 240, 0]] };

describe("route", () => {
  it("validatePlaces 丟棄缺座標者", () => {
    const { valid, dropped } = validatePlaces([
      { id: "1", name: "A", lat: 35.7, lng: 139.7, day: 1 },
      { id: "2", name: "B", day: 1 },
    ]);
    expect(valid).toHaveLength(1);
    expect(dropped).toBe(1);
  });
  it("legSeconds 依 mode 查表", () => {
    expect(legSeconds(matrix, "walk", 0, 2)).toBe(2520);
    expect(legSeconds(matrix, "drive", 0, 2)).toBe(600);
  });
  it("dayTotalSeconds 逐段不同 mode 加總", () => {
    // 順序 idx [0,1,2]，第一段 walk(720)，第二段 drive(240)
    expect(dayTotalSeconds(matrix, [0, 1, 2], ["walk", "drive"])).toBe(960);
  });
  it("isUnreasonable：超過 40 分鐘為真", () => {
    expect(isUnreasonable(2520)).toBe(true);
    expect(isUnreasonable(600)).toBe(false);
  });
});

describe("validatePlaces — dwellMin / kind 透傳", () => {
  it("合法 dwellMin 與 kind:lodging 保留", () => {
    const { valid } = validatePlaces([
      { id: "h", name: "🏨 Hotel", lat: 35.7, lng: 139.7, day: 1, dwellMin: 0, kind: "lodging" },
    ]);
    expect(valid).toHaveLength(1);
    expect(valid[0].dwellMin).toBe(0);
    expect(valid[0].kind).toBe("lodging");
  });
  it("非法 dwellMin（非數字）丟欄位但保留 place", () => {
    const { valid, dropped } = validatePlaces([
      { id: "a", name: "A", lat: 35.7, lng: 139.7, day: 1, dwellMin: "soon" },
    ]);
    expect(dropped).toBe(0);
    expect(valid).toHaveLength(1);
    expect(valid[0].dwellMin).toBeUndefined();
  });
  it("非法 kind（非 lodging）丟欄位但保留 place", () => {
    const { valid } = validatePlaces([
      { id: "a", name: "A", lat: 35.7, lng: 139.7, day: 1, kind: "museum" },
    ]);
    expect(valid).toHaveLength(1);
    expect(valid[0].kind).toBeUndefined();
  });
  it("必要欄位非法仍整筆丟棄", () => {
    const { valid, dropped } = validatePlaces([{ id: "a", name: "A", lat: "x", lng: 139.7, day: 1 }]);
    expect(valid).toHaveLength(0);
    expect(dropped).toBe(1);
  });
});
