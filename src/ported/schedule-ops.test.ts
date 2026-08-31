import { describe, it, expect } from "vitest";
import { computeSchedule, fmtHHMM, parseHHMM } from "./schedule-ops.js";

const matrix = {
  walk: [[0, 720, 3000], [720, 0, 480], [3000, 480, 0]],
  drive: [[0, 300, 1500], [300, 0, 240], [1500, 240, 0]],
};

describe("fmt/parse", () => {
  it("fmtHHMM", () => { expect(fmtHHMM(540)).toBe("09:00"); expect(fmtHHMM(642)).toBe("10:42"); });
  it("parseHHMM", () => { expect(parseHHMM("09:00")).toBe(540); expect(parseHHMM("10:42")).toBe(642); });
});

describe("computeSchedule", () => {
  it("純景點：出發+停留+交通串接", () => {
    const r = computeSchedule({
      items: [
        { kind: "place", placeId: "a", globalIndex: 0 },
        { kind: "place", placeId: "b", globalIndex: 1 },
      ],
      dayStartMin: 540, dwell: { a: 90, b: 60 }, matrix, legModes: ["walk"],
    });
    // a 09:00..10:30；交通 walk 720s=12分 → b 10:42
    expect(r.items[0].startMin).toBe(540);
    expect(r.items[1].transitBeforeMin).toBe(12);
    expect(r.items[1].startMin).toBe(642);
  });
  it("自由時間夾在中間：不加交通，但 A→B 交通在抵達 B 時計入", () => {
    const r = computeSchedule({
      items: [
        { kind: "place", placeId: "a", globalIndex: 0 },
        { kind: "free", id: "f1", durationMin: 30 },
        { kind: "place", placeId: "b", globalIndex: 1 },
      ],
      dayStartMin: 540, dwell: { a: 90, b: 60 }, matrix, legModes: ["walk"],
    });
    // a 09:00..10:30；free 10:30..11:00；交通12分 → b 11:12
    expect(r.items[1].kind).toBe("free");
    expect(r.items[1].startMin).toBe(630);
    expect(r.items[1].transitBeforeMin).toBeNull();
    expect(r.items[2].startMin).toBe(672);
  });
  it("drive 模式查 drive 矩陣", () => {
    const r = computeSchedule({
      items: [{ kind: "place", placeId: "a", globalIndex: 0 }, { kind: "place", placeId: "b", globalIndex: 1 }],
      dayStartMin: 540, dwell: { a: 0, b: 0 }, matrix, legModes: ["drive"],
    });
    expect(r.items[1].transitBeforeMin).toBe(5); // 300s
  });
  it("null 交通以 0 計", () => {
    const m2 = { walk: [[0, null], [null, 0]] as (number|null)[][], drive: [[0, null], [null, 0]] as (number|null)[][] };
    const r = computeSchedule({
      items: [{ kind: "place", placeId: "a", globalIndex: 0 }, { kind: "place", placeId: "b", globalIndex: 1 }],
      dayStartMin: 540, dwell: { a: 60, b: 0 }, matrix: m2, legModes: ["walk"],
    });
    expect(r.items[1].transitBeforeMin).toBe(0);
    expect(r.items[1].startMin).toBe(600);
  });
  it("overflow：超過 22:00", () => {
    const r = computeSchedule({
      items: [{ kind: "place", placeId: "a", globalIndex: 0 }],
      dayStartMin: 1350, dwell: { a: 120 }, matrix, legModes: [],
    });
    expect(r.overflow).toBe(true);
  });
  it("transit 段用 transitMin（分鐘），不查 matrix", () => {
    const r = computeSchedule({
      items: [{ kind:"place", placeId:"a", globalIndex:0 }, { kind:"place", placeId:"b", globalIndex:1 }],
      dayStartMin: 540, dwell: { a: 60, b: 0 }, matrix,
      legModes: ["transit"], transitMin: [62],
    });
    // a 09:00..10:00；transit 62 分 → b 11:02
    expect(r.items[1].transitBeforeMin).toBe(62);
    expect(r.items[1].startMin).toBe(662);
  });
});
