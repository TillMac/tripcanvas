import { useStore } from "zustand";
import { tripStore } from "../store/index.js";
import type { TripState } from "../store/types.js";

export function useTrip<T>(selector: (s: TripState) => T): T {
  return useStore(tripStore, selector);
}
