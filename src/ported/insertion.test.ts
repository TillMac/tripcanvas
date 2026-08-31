import { describe, it, expect } from "vitest";
import { computeBestInsertion } from "./insertion.js";

const P = (id: string, lat: number, lng: number) => ({ id, lat, lng });

describe("computeBestInsertion", () => {
  it("空清單退化", () => {
    const r = computeBestInsertion([], { lat: 35.7, lng: 139.7 });
    expect(r).toEqual({ afterIndex: 0, detourMin: 0, beforeId: null, afterId: null });
  });
  it("單站：插頭或尾、前後其一為該站", () => {
    const r = computeBestInsertion([P("a", 35.70, 139.70)], { lat: 35.71, lng: 139.70 });
    expect(r.afterIndex === 0 || r.afterIndex === 1).toBe(true);
    expect([r.beforeId, r.afterId]).toContain("a");
  });
  it("候選靠近中段 → 插在該段、前後 id 正確", () => {
    // a(0,0)──b(0,1)──c(0,2)，候選靠近 b 與 c 之間 (0,1.5)
    const r = computeBestInsertion([P("a", 0, 0), P("b", 0, 1), P("c", 0, 2)], { lat: 0, lng: 1.5 });
    expect(r.beforeId).toBe("b");
    expect(r.afterId).toBe("c");
    expect(r.afterIndex).toBe(2);
  });
});
