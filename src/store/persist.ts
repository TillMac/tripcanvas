// localStorage persistence (docs/design/tool-layer.md §5): trip state minus
// matrices/resolvingPins, debounced 250ms on rev change, zod-parsed on boot,
// corrupt storage yields a fresh trip.
import { z } from "zod";
import type { StoreApi } from "zustand/vanilla";
import { initialTrip } from "./store.js";
import type { TripState } from "./types.js";

export const TRIP_KEY = "tripcanvas:trip:v1";
export const PERSIST_DEBOUNCE_MS = 250;

const StopSchema = z.object({
  place: z.string(),
  dwellMin: z.number(),
  freeAfterMin: z.number(),
  pending: z.string().optional(),
});

const PersistedSchema = z.object({
  rev: z.number().int().min(0),
  places: z.record(z.object({ id: z.string(), name: z.string(), lat: z.number(), lon: z.number(), query: z.string() })),
  days: z.array(z.object({ start: z.string(), stops: z.array(z.string()), freeStartMin: z.number().optional() })),
  nights: z.array(z.string().nullable()),
  stops: z.record(StopSchema),
  candidates: z.array(z.string()),
  legOverrides: z.record(z.any()),
  log: z.array(z.any()),
  historyStartRev: z.number(),
  lastAgentReadRev: z.number(),
  endLastDayAtLodging: z.boolean(),
  aliases: z.record(z.string()),
  nextS: z.number(),
  nextC: z.number(),
  nextE: z.number(),
  nextP: z.number(),
});

type Persisted = z.infer<typeof PersistedSchema>;

function pick(s: TripState): Persisted {
  const { matrices: _m, resolvingPins: _r, ...rest } = s;
  return { ...rest, log: rest.log.slice(-200) };
}

export function loadTrip(storage: Pick<Storage, "getItem">): TripState {
  try {
    const raw = storage.getItem(TRIP_KEY);
    if (!raw) return initialTrip();
    const parsed = PersistedSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return initialTrip();
    return { ...initialTrip(), ...parsed.data };
  } catch {
    return initialTrip();
  }
}

/** Subscribe and write on rev change, debounced. Returns an unsubscribe fn. */
export function attachPersistence(
  store: StoreApi<TripState>,
  storage: Pick<Storage, "setItem">,
  debounceMs = PERSIST_DEBOUNCE_MS,
): () => void {
  let prevRev = store.getState().rev;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsub = store.subscribe((s) => {
    if (s.rev === prevRev) return;
    prevRev = s.rev;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        storage.setItem(TRIP_KEY, JSON.stringify(pick(store.getState())));
      } catch {
        /* storage full/blocked — trip stays in memory */
      }
    }, debounceMs);
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsub();
  };
}
