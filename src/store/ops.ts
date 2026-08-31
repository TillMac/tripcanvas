import type { Op, Sid, TripState } from "./types.js";

/** Follow the alias chain to the current display id; null when the stop is gone. */
export function resolveSid(state: TripState, id: string): Sid | null {
  let x = id;
  let hops = 0;
  while (!state.stops[x] && state.aliases[x] && hops++ < 10) x = state.aliases[x];
  return state.stops[x] ? x : null;
}

/** Which day (1-based) holds this sid, or 0 when it is a candidate, or -1 when nowhere. */
export function locate(state: TripState, sid: Sid): { day: number; index: number } {
  for (let d = 0; d < state.days.length; d++) {
    const i = state.days[d].stops.indexOf(sid);
    if (i >= 0) return { day: d + 1, index: i };
  }
  const c = state.candidates.indexOf(sid);
  if (c >= 0) return { day: 0, index: c };
  return { day: -1, index: -1 };
}

/** Apply one op immutably. Ops address items by id; unknown ids are no-ops. */
export function applyOp(s: TripState, op: Op): TripState {
  switch (op.t) {
    case "addPlace":
      return { ...s, places: { ...s.places, [op.place.id]: op.place } };
    case "addStop":
      return { ...s, stops: { ...s.stops, [op.sid]: { ...op.stop } } };
    case "delStop": {
      const stops = { ...s.stops };
      delete stops[op.sid];
      return { ...s, stops };
    }
    case "insertDay": {
      const days = s.days.map((d, i) => {
        if (i !== op.day - 1) return d;
        const list = d.stops.slice();
        list.splice(Math.min(op.index, list.length), 0, op.sid);
        return { ...d, stops: list };
      });
      return { ...s, days };
    }
    case "removeFromDay": {
      const days = s.days.map((d) =>
        d.stops.includes(op.sid) ? { ...d, stops: d.stops.filter((x) => x !== op.sid) } : d,
      );
      return { ...s, days };
    }
    case "insertCand": {
      const candidates = s.candidates.slice();
      candidates.splice(Math.min(op.index, candidates.length), 0, op.sid);
      return { ...s, candidates };
    }
    case "removeCand":
      return { ...s, candidates: s.candidates.filter((x) => x !== op.sid) };
    case "renameStop": {
      const stop = s.stops[op.from];
      if (!stop) return s;
      const stops = { ...s.stops };
      delete stops[op.from];
      stops[op.to] = stop;
      const aliases = { ...s.aliases, [op.from]: op.to };
      delete aliases[op.to];
      const days = s.days.map((d) =>
        d.stops.includes(op.from) ? { ...d, stops: d.stops.map((x) => (x === op.from ? op.to : x)) } : d,
      );
      const candidates = s.candidates.map((x) => (x === op.from ? op.to : x));
      return { ...s, stops, aliases, days, candidates };
    }
    case "setStop": {
      const stop = s.stops[op.sid];
      if (!stop) return s;
      return { ...s, stops: { ...s.stops, [op.sid]: { ...stop, ...op.patch } } };
    }
    case "setPending": {
      const stop = s.stops[op.sid];
      if (!stop) return s;
      const next = { ...stop };
      if (op.editId === undefined) delete next.pending;
      else next.pending = op.editId;
      return { ...s, stops: { ...s.stops, [op.sid]: next } };
    }
    case "setDayStart":
      return { ...s, days: s.days.map((d, i) => (i === op.day - 1 ? { ...d, start: op.start } : d)) };
    case "setDayFreeStart":
      return { ...s, days: s.days.map((d, i) => (i === op.day - 1 ? { ...d, freeStartMin: op.min } : d)) };
    case "setNight": {
      const nights = s.nights.slice();
      nights[op.night] = op.pid;
      return { ...s, nights };
    }
    case "setLeg": {
      const legOverrides = { ...s.legOverrides };
      if (op.value === null) delete legOverrides[op.key];
      else legOverrides[op.key] = op.value;
      return { ...s, legOverrides };
    }
    case "setEndToggle":
      return { ...s, endLastDayAtLodging: op.v };
    case "setTrip":
      return {
        ...s,
        days: op.days,
        nights: op.nights,
        candidates: op.candidates,
        stops: op.stops,
        places: op.places,
        legOverrides: op.legOverrides,
      };
  }
}

export function applyOps(s: TripState, ops: Op[]): TripState {
  return ops.reduce(applyOp, s);
}
