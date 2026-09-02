// One-click sample trip (MLP: a visitor with no agent still sees the product).
// Loaded as ONE human commit — undoable, honest (no fabricated agent edits);
// the matrix service then fetches real OSRM times as with any edit.
import type { createTripStore } from "./store.js";
import type { DayRec, Pid, Place, Sid, Stop } from "./types.js";

const P = (id: Pid, name: string, lat: number, lon: number): Place => ({ id, name, lat, lon, query: name.toLowerCase() });
const S = (place: Pid, dwellMin: number): Stop => ({ place, dwellMin, freeAfterMin: 0 });

const PLACES: Place[] = [
  P("p1", "Hotel Gracery Shinjuku", 35.6945, 139.7005),
  P("p2", "Senso-ji Temple", 35.7148, 139.7967),
  P("p3", "Tokyo National Museum", 35.7188, 139.7765),
  P("p4", "Ueno Park", 35.7141, 139.7744),
  P("p5", "Akihabara Electric Town", 35.7022, 139.7741),
  P("p6", "Meiji Shrine", 35.6764, 139.6993),
  P("p7", "Takeshita Street", 35.6716, 139.7031),
  P("p8", "Shibuya Crossing", 35.6595, 139.7005),
  P("p9", "Shinjuku Gyoen", 35.6852, 139.71),
  P("p10", "teamLab Planets", 35.649, 139.7898),
  P("p11", "Tsukiji Outer Market", 35.6654, 139.7707),
  P("p12", "Ghibli Museum", 35.6962, 139.5704),
  P("p13", "Odaiba Seaside Park", 35.63, 139.773),
];

const STOPS: Record<Sid, Stop> = {
  s1: S("p2", 90), s2: S("p3", 120), s3: S("p4", 60), s4: S("p5", 90),
  s5: S("p6", 75), s6: S("p7", 60), s7: S("p8", 45), s8: S("p9", 90),
  s9: S("p10", 120), s10: S("p11", 90),
  c1: S("p12", 120), c2: S("p13", 60),
};

const DAYS: DayRec[] = [
  { start: "09:00", stops: ["s1", "s2", "s3", "s4"] },
  { start: "09:00", stops: ["s5", "s6", "s7", "s8"] },
  { start: "09:00", stops: ["s9", "s10"] },
];

export function loadSampleTrip(trip: Pick<ReturnType<typeof createTripStore>, "store" | "actions">): void {
  trip.store.setState({ nextP: 14, nextS: 11, nextC: 3, nextE: 1 });
  trip.actions.planCommit(
    "human",
    {
      places: Object.fromEntries(PLACES.map((p) => [p.id, p])),
      stops: STOPS,
      days: DAYS,
      nights: ["p1", "p1", "p1"],
      candidates: ["c1", "c2"],
    },
    "loaded the sample Tokyo trip",
  );
}
