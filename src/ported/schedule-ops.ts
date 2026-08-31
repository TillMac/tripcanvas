import type { ModeMatrices, TransportMode } from "./route-ops.js";
import { legSeconds } from "./route-ops.js";

export type SchedKind = "place" | "free";
export type SchedItemInput =
  | { kind: "place"; placeId: string; globalIndex: number }
  | { kind: "free"; id: string; durationMin: number };

export interface SchedItem {
  kind: SchedKind;
  ref: string;
  startMin: number;
  endMin: number;
  transitBeforeMin: number | null;
}
export interface SchedResult { items: SchedItem[]; dayEndMin: number; overflow: boolean }

export const DEFAULT_DWELL_MIN = 60;
const OVERFLOW_AFTER_MIN = 22 * 60;

export function computeSchedule(input: {
  items: SchedItemInput[];
  dayStartMin: number;
  dwell: Record<string, number>;
  matrix: ModeMatrices;
  legModes: TransportMode[];
  transitMin?: (number | null)[];
}): SchedResult {
  const { items, dayStartMin, dwell, matrix, legModes } = input;
  let clock = dayStartMin;
  let prevPlaceIdx: number | null = null;
  let legCounter = 0;
  const out: SchedItem[] = [];
  for (const item of items) {
    if (item.kind === "place") {
      let transitBeforeMin: number | null = null;
      if (prevPlaceIdx != null) {
        const mode: TransportMode = legModes[legCounter] ?? "walk";
        let mins: number;
        if (mode === "transit") {
          mins = input.transitMin?.[legCounter] ?? 0;
        } else {
          const sec = legSeconds(matrix, mode, prevPlaceIdx, item.globalIndex);
          mins = Math.round((sec ?? 0) / 60);
        }
        transitBeforeMin = mins; clock += mins; legCounter++;
      }
      const startMin = clock;
      clock += dwell[item.placeId] ?? DEFAULT_DWELL_MIN;
      out.push({ kind: "place", ref: item.placeId, startMin, endMin: clock, transitBeforeMin });
      prevPlaceIdx = item.globalIndex;
    } else {
      const startMin = clock;
      clock += item.durationMin;
      out.push({ kind: "free", ref: item.id, startMin, endMin: clock, transitBeforeMin: null });
    }
  }
  return { items: out, dayEndMin: clock, overflow: clock > OVERFLOW_AFTER_MIN };
}

export function fmtHHMM(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
export function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}
