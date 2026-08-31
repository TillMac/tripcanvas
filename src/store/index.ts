// Real-deps singleton wiring: localStorage persistence, OSRM matrix service,
// the one app-wide Nominatim queue. Tests build their own instances instead.
import { createTripStore } from "./store.js";
import { MatrixService } from "./matrix.js";
import { NominatimQueue } from "./nominatim.js";
import { loadTrip, attachPersistence } from "./persist.js";
import { makeTransitFetcher } from "./transit.js";

const storage = typeof localStorage !== "undefined" ? localStorage : undefined;

// eslint-disable-next-line prefer-const
let matrixServiceRef: { current: MatrixService | null } = { current: null };

export const trip = createTripStore({
  afterCommit: (s, actor) => matrixServiceRef.current?.onCommit(s, actor),
});

if (storage) {
  trip.store.setState({ ...loadTrip(storage) }, true);
  attachPersistence(trip.store, storage);
}

export const matrixService = new MatrixService(trip.store, { storage });
matrixServiceRef.current = matrixService;
// A restored trip may need its matrix (from the per-hash cache, else OSRM).
void matrixService.ensureFresh();

export const nominatim = new NominatimQueue({ storage });

export const fetchTransit = makeTransitFetcher();

export const { store: tripStore, actions } = trip;
