import type { DurationMatrix } from "./osrm.js";

export type TransportMode = "walk" | "drive" | "transit";
export interface ModeMatrices { walk: DurationMatrix; drive: DurationMatrix }

export const UNREASONABLE_SECONDS = 40 * 60;

export function legSeconds(m: ModeMatrices, mode: TransportMode, from: number, to: number): number | null {
  const matrix = m[mode as keyof ModeMatrices];
  return matrix?.[from]?.[to] ?? null;
}

// order: place index 順序；legModes: 第 i 段（order[i]→order[i+1]）的 mode，長度 order.length-1
export function dayTotalSeconds(m: ModeMatrices, order: number[], legModes: TransportMode[]): number {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) {
    const s = legSeconds(m, legModes[i] ?? "walk", order[i], order[i + 1]);
    if (s != null) total += s;
  }
  return total;
}

export function isUnreasonable(sec: number | null): boolean {
  return sec != null && sec > UNREASONABLE_SECONDS;
}
