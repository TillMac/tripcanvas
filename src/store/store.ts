// The trip's single source of truth (docs/design/tool-layer.md §5, ADR-0004).
// One zustand vanilla store — tools live outside React and need getState/subscribe.
// Every mutation, button or tool, goes through commit(group, actor): apply by-id
// ops -> rev++ -> append log entry (log = undo stack = change feed, cap 200) ->
// agent groups get editIds + pending marks -> afterCommit hook (persist, matrix).
import { createStore, type StoreApi } from "zustand/vanilla";
import { computeBestInsertion } from "../ported/insertion.js";
import { locate, resolveSid, applyOps } from "./ops.js";
import type {
  Actor, CommitGroup, DayRec, EditStatus, Eid, LegOverride, LogEntry, Op,
  Pid, Place, Sid, Stop, TripState, ResolvingPin,
} from "./types.js";

const LOG_CAP = 200;
export const DEFAULT_DAY_START = "09:00";
export const DEFAULT_DWELL_MIN = 60;

export function initialTrip(): TripState {
  return {
    rev: 0,
    places: {},
    days: [],
    nights: [],
    stops: {},
    candidates: [],
    legOverrides: {},
    matrices: { ids: [], forHash: "", stale: false },
    log: [],
    historyStartRev: 0,
    lastAgentReadRev: 0,
    resolvingPins: [],
    endLastDayAtLodging: true,
    aliases: {},
    nextS: 1,
    nextC: 1,
    nextE: 1,
    nextP: 1,
  };
}

export interface PlaceInput {
  name: string;
  lat: number;
  lon: number;
  query: string;
}

export interface TripStoreDeps {
  /** Called after every commit (persist trigger, matrix hash check). */
  afterCommit?: (state: TripState, actor: Actor) => void;
}

export type TripStore = ReturnType<typeof createTripStore>;

export function createTripStore(deps: TripStoreDeps = {}) {
  const store: StoreApi<TripState> = createStore<TripState>(() => initialTrip());
  const get = store.getState;

  // ── commit gate ──────────────────────────────────────────────────────────
  function commit(group: CommitGroup, actor: Actor): { rev: number; editId?: Eid } {
    let s = get();
    const entries: LogEntry[] = [];

    // Human dispatch touching a pending stop clears its mark first (implicit
    // accept, logged) — so revert only ever touches human-untouched items.
    if (actor === "human" && group.sids) {
      for (const sid of group.sids) {
        const cur = resolveSid(s, sid);
        const e = cur ? s.stops[cur]?.pending : undefined;
        if (cur && e) {
          const ops: Op[] = [{ t: "setPending", sid: cur, editId: undefined }];
          const inverse: Op[] = [{ t: "setPending", sid: cur, editId: e }];
          s = applyOps(s, ops);
          entries.push({
            rev: 0, // assigned below
            actor: "human",
            op: "accept",
            summary: `accepted your ${e} ([${cur}])`,
            ops,
            inverse,
            editIds: [e],
            sids: [cur],
            fate: "accepted",
          });
        }
      }
    }

    let editId: Eid | undefined;
    let ops = group.ops;
    let inverse = group.inverse;
    if (actor === "agent") {
      editId = `e${s.nextE}`;
      s = { ...s, nextE: s.nextE + 1 };
      const markOps: Op[] = [];
      const markInv: Op[] = [];
      for (const sid of group.sids ?? []) {
        markOps.push({ t: "setPending", sid, editId });
        markInv.push({ t: "setPending", sid, editId: s.stops[sid]?.pending });
      }
      ops = [...ops, ...markOps];
      inverse = [...markInv, ...inverse];
    }

    s = applyOps(s, ops);
    entries.push({
      rev: 0, // fixed below
      actor,
      op: group.op,
      summary: group.summary,
      ops,
      inverse,
      editId,
      sids: group.sids,
    });

    // Assign revs in order and append.
    let rev = get().rev;
    let log = s.log.slice();
    for (const entry of entries) {
      rev += 1;
      entry.rev = rev;
      log.push(entry);
    }
    let historyStartRev = s.historyStartRev;
    while (log.length > LOG_CAP) {
      historyStartRev = log[0].rev;
      log = log.slice(1);
    }
    s = { ...s, rev, log, historyStartRev };
    store.setState(s, true);
    deps.afterCommit?.(s, actor);
    return { rev, editId };
  }

  // ── id helpers ───────────────────────────────────────────────────────────
  function freshSid(s: TripState): { sid: Sid; bump: Partial<TripState> } {
    return { sid: `s${s.nextS}`, bump: { nextS: s.nextS + 1 } };
  }
  function freshCid(s: TripState): { sid: Sid; bump: Partial<TripState> } {
    return { sid: `c${s.nextC}`, bump: { nextC: s.nextC + 1 } };
  }
  function ensurePlace(s: TripState, input: PlaceInput): { pid: Pid; ops: Op[]; bump: Partial<TripState> } {
    const existing = Object.values(s.places).find((p) => p.query === input.query && p.lat === input.lat && p.lon === input.lon);
    if (existing) return { pid: existing.id, ops: [], bump: {} };
    const pid = `p${s.nextP}`;
    return {
      pid,
      ops: [{ t: "addPlace", place: { id: pid, name: input.name, lat: input.lat, lon: input.lon, query: input.query } }],
      bump: { nextP: s.nextP + 1 },
    };
  }
  function bestIndex(s: TripState, day: number, lat: number, lon: number): number {
    const list = (s.days[day - 1]?.stops ?? [])
      .map((sid) => {
        const p = s.places[s.stops[sid].place];
        return { id: sid, lat: p.lat, lng: p.lon };
      });
    return computeBestInsertion(list, { lat, lng: lon }).afterIndex;
  }

  // ── actions (exported for both UI buttons and tools; actor-tagged) ──────
  const actions = {
    /** Add a resolved place as a stop on a day (best insertion when no position) or as a candidate. */
    addResolvedStop(
      actor: Actor,
      input: PlaceInput,
      opts: { day?: number; position?: number; dwellMin?: number } = {},
    ): { sid: Sid; day: number; position: number } {
      let s = get();
      const { pid, ops: placeOps, bump } = ensurePlace(s, input);
      store.setState(bump);
      s = get();
      const stop: Stop = { place: pid, dwellMin: opts.dwellMin ?? DEFAULT_DWELL_MIN, freeAfterMin: 0 };
      if (opts.day && opts.day >= 1) {
        const { sid, bump: b2 } = freshSid(s);
        store.setState(b2);
        const index = opts.position != null ? opts.position - 1 : bestIndex(get(), opts.day, input.lat, input.lon);
        commit(
          {
            op: "add",
            summary: `added [${sid}] ${input.name} to D${opts.day} pos${index + 1}`,
            ops: [...placeOps, { t: "addStop", sid, stop }, { t: "insertDay", sid, day: opts.day, index }],
            inverse: [{ t: "removeFromDay", sid }, { t: "delStop", sid }],
            sids: [sid],
          },
          actor,
        );
        return { sid, day: opts.day, position: index + 1 };
      }
      const { sid, bump: b2 } = freshCid(s);
      store.setState(b2);
      const index = get().candidates.length;
      commit(
        {
          op: "add",
          summary: `added [${sid}] ${input.name} as a candidate`,
          ops: [...placeOps, { t: "addStop", sid, stop }, { t: "insertCand", sid, index }],
          inverse: [{ t: "removeCand", sid }, { t: "delStop", sid }],
          sids: [sid],
        },
        actor,
      );
      return { sid, day: 0, position: index + 1 };
    },

    /** Move a stop to another day/position, candidate -> day, or day -> candidates (day 0). */
    moveStop(
      actor: Actor,
      sidIn: string,
      day: number,
      position?: number,
    ): { sid: Sid; from: { day: number; index: number }; to: { day: number; index: number } } | { error: string } {
      const s = get();
      const sid = resolveSid(s, sidIn);
      if (!sid) return { error: `no stop [${sidIn}] — ids come from get_itinerary.` };
      if (day < 0 || day > s.days.length) return { error: `day ${day} out of range (trip has ${s.days.length}).` };
      const from = locate(s, sid);
      const place = s.places[s.stops[sid].place];

      if (day === 0) {
        if (from.day === 0) return { error: `[${sid}] is already a candidate.` };
        const { sid: cid, bump } = freshCid(s);
        store.setState(bump);
        const index = get().candidates.length;
        commit(
          {
            op: "move",
            summary: `unassigned [${sid}] ${place.name} to candidates as [${cid}]`,
            ops: [{ t: "removeFromDay", sid }, { t: "renameStop", from: sid, to: cid }, { t: "insertCand", sid: cid, index }],
            inverse: [{ t: "removeCand", sid: cid }, { t: "renameStop", from: cid, to: sid }, { t: "insertDay", sid, day: from.day, index: from.index }],
            sids: [cid],
          },
          actor,
        );
        return { sid: cid, from, to: { day: 0, index } };
      }

      if (from.day === 0) {
        const { sid: nsid, bump } = freshSid(s);
        store.setState(bump);
        const index = position != null ? position - 1 : bestIndex(get(), day, place.lat, place.lon);
        commit(
          {
            op: "move",
            summary: `placed candidate [${sid}] ${place.name} on D${day} pos${index + 1} as [${nsid}]`,
            ops: [{ t: "removeCand", sid }, { t: "renameStop", from: sid, to: nsid }, { t: "insertDay", sid: nsid, day, index }],
            inverse: [{ t: "removeFromDay", sid: nsid }, { t: "renameStop", from: nsid, to: sid }, { t: "insertCand", sid, index: from.index }],
            sids: [nsid],
          },
          actor,
        );
        return { sid: nsid, from, to: { day, index } };
      }

      // day -> day (or reorder within a day)
      const sAfterRemove = applyOps(s, [{ t: "removeFromDay", sid }]);
      const index = position != null ? position - 1 : bestIndex(sAfterRemove, day, place.lat, place.lon);
      commit(
        {
          op: "move",
          summary:
            from.day === day
              ? `moved [${sid}] ${place.name} D${day} pos${from.index + 1} -> pos${index + 1}`
              : `moved [${sid}] ${place.name} D${from.day} pos${from.index + 1} -> D${day} pos${index + 1}`,
          ops: [{ t: "removeFromDay", sid }, { t: "insertDay", sid, day, index }],
          inverse: [{ t: "removeFromDay", sid }, { t: "insertDay", sid, day: from.day, index: from.index }],
          sids: [sid],
        },
        actor,
      );
      return { sid, from, to: { day, index } };
    },

    setDwell(actor: Actor, sidIn: string, dwellMin: number): { sid: Sid; prev: number } | { error: string } {
      const s = get();
      const sid = resolveSid(s, sidIn);
      if (!sid) return { error: `no stop [${sidIn}].` };
      const prev = s.stops[sid].dwellMin;
      commit(
        {
          op: "dwell",
          summary: `set [${sid}] dwell ${prev} -> ${dwellMin}`,
          ops: [{ t: "setStop", sid, patch: { dwellMin } }],
          inverse: [{ t: "setStop", sid, patch: { dwellMin: prev } }],
          sids: [sid],
        },
        actor,
      );
      return { sid, prev };
    },

    setFreeAfter(actor: Actor, sidIn: string, freeAfterMin: number): { sid: Sid; prev: number } | { error: string } {
      const s = get();
      const sid = resolveSid(s, sidIn);
      if (!sid) return { error: `no stop [${sidIn}].` };
      const prev = s.stops[sid].freeAfterMin;
      commit(
        {
          op: "free",
          summary: `set free time after [${sid}] ${prev} -> ${freeAfterMin} min`,
          ops: [{ t: "setStop", sid, patch: { freeAfterMin } }],
          inverse: [{ t: "setStop", sid, patch: { freeAfterMin: prev } }],
          sids: [sid],
        },
        actor,
      );
      return { sid, prev };
    },

    setDayStart(actor: Actor, day: number, start: string): { prev: string } | { error: string } {
      const s = get();
      if (day < 1 || day > s.days.length) return { error: `day ${day} out of range (trip has ${s.days.length}).` };
      const prev = s.days[day - 1].start;
      commit(
        {
          op: "dayStart",
          summary: `D${day} starts ${start} (was ${prev})`,
          ops: [{ t: "setDayStart", day, start }],
          inverse: [{ t: "setDayStart", day, start: prev }],
        },
        actor,
      );
      return { prev };
    },

    setDayFreeStart(actor: Actor, day: number, min: number): { prev: number } | { error: string } {
      const s = get();
      if (day < 1 || day > s.days.length) return { error: `day ${day} out of range (trip has ${s.days.length}).` };
      const prev = s.days[day - 1].freeStartMin ?? 0;
      commit(
        {
          op: "freeStart",
          summary: `free time at D${day} start ${prev} -> ${min} min`,
          ops: [{ t: "setDayFreeStart", day, min }],
          inverse: [{ t: "setDayFreeStart", day, min: prev }],
        },
        actor,
      );
      return { prev };
    },

    /** Override the leg arriving at toSid (pair-keyed from the stop/lodging before it). */
    setLegOverride(
      actor: Actor,
      key: string,
      value: LegOverride | null,
      markSid?: Sid,
      summary?: string,
    ): void {
      const s = get();
      const prev = s.legOverrides[key] ?? null;
      commit(
        {
          op: "leg",
          summary: summary ?? `leg ${key} -> ${value?.mode ?? "default"}`,
          ops: [{ t: "setLeg", key, value }],
          inverse: [{ t: "setLeg", key, value: prev }],
          sids: markSid ? [markSid] : undefined,
        },
        actor,
      );
    },

    /** Anchor nights to a lodging place. Omit nights for every night. */
    setLodging(actor: Actor, input: PlaceInput, nights?: number[]): { pid: Pid; nights: number[] } | { error: string } {
      let s = get();
      const D = s.days.length;
      if (D === 0) return { error: "trip has no days yet — plan_trip or add a day first." };
      const target = nights ?? Array.from({ length: D }, (_, i) => i);
      for (const n of target) {
        if (n < 0 || n >= D) return { error: `night ${n} out of range (nights 0-${D - 1}).` };
      }
      const { pid, ops: placeOps, bump } = ensurePlace(s, input);
      store.setState(bump);
      s = get();
      const ops: Op[] = [...placeOps, ...target.map((n): Op => ({ t: "setNight", night: n, pid }))];
      const inverse: Op[] = target.map((n): Op => ({ t: "setNight", night: n, pid: s.nights[n] ?? null }));
      const label =
        target.length === D ? "all nights" : `night${target.length > 1 ? "s" : ""} ${target.join(", ")}`;
      commit(
        { op: "lodging", summary: `lodging ${label} -> ${input.name}`, ops, inverse },
        actor,
      );
      return { pid, nights: target };
    },

    setEndLastDayAtLodging(actor: Actor, v: boolean): void {
      const prev = get().endLastDayAtLodging;
      if (prev === v) return;
      commit(
        {
          op: "endToggle",
          summary: `last day ends at ${v ? "lodging" : "its final stop"}`,
          ops: [{ t: "setEndToggle", v }],
          inverse: [{ t: "setEndToggle", v: prev }],
        },
        actor,
      );
    },

    /** Replace day assignment/order wholesale (Arrange, day-count change). One undoable group. */
    applyArrangement(
      actor: Actor,
      next: { days: DayRec[]; nights: (Pid | null)[]; candidates: Sid[] },
      summary: string,
    ): void {
      const s = get();
      const snapshot: Op = {
        t: "setTrip", days: s.days, nights: s.nights, candidates: s.candidates,
        stops: s.stops, places: s.places, legOverrides: s.legOverrides,
      };
      const placed = next.days.flatMap((d) => d.stops);
      commit(
        {
          op: "arrange",
          summary,
          ops: [{ t: "setTrip", days: next.days, nights: next.nights, candidates: next.candidates, stops: s.stops, places: s.places, legOverrides: s.legOverrides }],
          inverse: [snapshot],
          sids: actor === "agent" ? placed : undefined,
        },
        actor,
      );
    },

    /** Atomic whole-trip commit for plan_trip: places+stops+days+nights in ONE group. */
    planCommit(
      actor: Actor,
      next: {
        places: Record<Pid, Place>; stops: Record<Sid, Stop>; days: DayRec[];
        nights: (Pid | null)[]; candidates: Sid[];
      },
      summary: string,
    ): { editId?: Eid } {
      const s = get();
      const snapshot: Op = {
        t: "setTrip", days: s.days, nights: s.nights, candidates: s.candidates,
        stops: s.stops, places: s.places, legOverrides: s.legOverrides,
      };
      const { editId } = commit(
        {
          op: "plan",
          summary,
          ops: [{ t: "setTrip", days: next.days, nights: next.nights, candidates: next.candidates, stops: next.stops, places: next.places, legOverrides: {} }],
          inverse: [snapshot],
          sids: Object.keys(next.stops).filter((sid) => !(sid in s.stops)),
        },
        actor,
      );
      return { editId };
    },

    /** Create empty days up to count (human building by hand). */
    ensureDays(actor: Actor, count: number): void {
      const s = get();
      if (count <= s.days.length) return;
      const days = [
        ...s.days,
        ...Array.from({ length: count - s.days.length }, (): DayRec => ({ start: DEFAULT_DAY_START, stops: [] })),
      ];
      const nights = s.nights.slice();
      while (nights.length < count) nights.push(nights[nights.length - 1] ?? null);
      commit(
        {
          op: "days",
          summary: `trip grown to ${count} day${count > 1 ? "s" : ""}`,
          ops: [{ t: "setTrip", days, nights, candidates: s.candidates, stops: s.stops, places: s.places, legOverrides: s.legOverrides }],
          inverse: [{ t: "setTrip", days: s.days, nights: s.nights, candidates: s.candidates, stops: s.stops, places: s.places, legOverrides: s.legOverrides }],
        },
        actor,
      );
    },

    /** One commit for set_times: dayStart and/or a stop's dwell/free knobs. */
    setTimes(
      actor: Actor,
      day: number,
      opts: { dayStart?: string; sid?: string; dwellMin?: number; freeAfterMin?: number },
    ):
      | { sid?: Sid; prevStart?: string; prevDwell?: number; prevFree?: number }
      | { error: string } {
      const s = get();
      if (day < 1 || day > s.days.length) return { error: `day ${day} out of range (trip has ${s.days.length}).` };
      const ops: Op[] = [];
      const inverse: Op[] = [];
      const parts: string[] = [];
      const out: { sid?: Sid; prevStart?: string; prevDwell?: number; prevFree?: number } = {};
      if (opts.dayStart) {
        out.prevStart = s.days[day - 1].start;
        ops.push({ t: "setDayStart", day, start: opts.dayStart });
        inverse.unshift({ t: "setDayStart", day, start: out.prevStart });
        parts.push(`D${day} starts ${opts.dayStart}`);
      }
      let sid: Sid | undefined;
      if (opts.sid !== undefined) {
        const r = resolveSid(s, opts.sid);
        if (!r) return { error: `no stop [${opts.sid}].` };
        if (!s.days[day - 1].stops.includes(r)) return { error: `[${r}] is not on day ${day}.` };
        sid = r;
        out.sid = r;
        if (opts.dwellMin !== undefined) {
          out.prevDwell = s.stops[r].dwellMin;
          ops.push({ t: "setStop", sid: r, patch: { dwellMin: opts.dwellMin } });
          inverse.unshift({ t: "setStop", sid: r, patch: { dwellMin: out.prevDwell } });
          parts.push(`[${r}] dwell ${out.prevDwell} -> ${opts.dwellMin}`);
        }
        if (opts.freeAfterMin !== undefined) {
          out.prevFree = s.stops[r].freeAfterMin;
          ops.push({ t: "setStop", sid: r, patch: { freeAfterMin: opts.freeAfterMin } });
          inverse.unshift({ t: "setStop", sid: r, patch: { freeAfterMin: out.prevFree } });
          parts.push(`free after [${r}] ${out.prevFree} -> ${opts.freeAfterMin} min`);
        }
      }
      if (ops.length === 0) return { error: "give dayStart, or stop with dwellMinutes/freeMinutesAfter." };
      commit(
        { op: "times", summary: parts.join("; "), ops, inverse, sids: sid ? [sid] : undefined },
        actor,
      );
      return out;
    },

    // ── review (ADR-0004) ──────────────────────────────────────────────────
    accept(editId: Eid): { accepted: Sid[] } | { error: string } {
      const s = get();
      const status = editStatus(s, editId);
      if (!status) return { error: `no edit ${editId}.` };
      if (status.pendingSids.length === 0) return { error: `${editId} is already resolved.` };
      const ops: Op[] = status.pendingSids.map((sid): Op => ({ t: "setPending", sid, editId: undefined }));
      const inverse: Op[] = status.pendingSids.map((sid): Op => ({ t: "setPending", sid, editId }));
      commit(
        {
          op: "accept",
          summary: `accepted ${editId} (${status.pendingSids.map((x) => `[${x}]`).join(" ")})`,
          ops,
          inverse,
        },
        "human",
      );
      markFate(editId, "accepted");
      return { accepted: status.pendingSids };
    },

    acceptAll(): { edits: Eid[] } {
      const s = get();
      const pend = pendingEdits(s);
      const sids = pend.flatMap((p) => p.pendingSids);
      const ops: Op[] = sids.map((sid): Op => ({ t: "setPending", sid, editId: undefined }));
      const inverse: Op[] = sids.map((sid): Op => ({ t: "setPending", sid, editId: s.stops[sid]?.pending }));
      if (pend.length === 0) return { edits: [] };
      commit(
        {
          op: "accept",
          summary: `accepted all pending edits (${pend.map((p) => p.editId).join(", ")})`,
          ops,
          inverse,
        },
        "human",
      );
      for (const p of pend) markFate(p.editId, "accepted");
      return { edits: pend.map((p) => p.editId) };
    },

    /** Revert an edit's still-pending members by stored inverse; report kept (accepted) ones. */
    revert(actor: Actor, editId: Eid): { reverted: Sid[]; kept: Sid[] } | { error: string } {
      const s = get();
      const status = editStatus(s, editId);
      if (!status) return { error: `no edit ${editId} — ids come from get_changes.` };
      if (status.fate === "reverted") return { error: `${editId} was already reverted.` };
      const entry = status.entry;
      const hasSids = (entry.sids?.length ?? 0) > 0;
      if (hasSids && status.pendingSids.length === 0) {
        return { error: `${editId} was fully accepted — ask the human to undo.` };
      }
      if (!hasSids && status.fate === "accepted") {
        return { error: `${editId} was fully accepted — ask the human to undo.` };
      }
      const still = new Set(status.pendingSids);
      const partial = hasSids && status.keptSids.length > 0;
      const snapshot = entry.inverse.find((op): op is Extract<Op, { t: "setTrip" }> => op.t === "setTrip");
      let inverseToApply: Op[];
      let redo: Op[];
      if (partial && snapshot) {
        // Snapshot groups (plan/arrange): revert still-pending members one by
        // one — remove ones the group created, move pre-existing ones back to
        // their snapshot location. Accepted members stay untouched.
        inverseToApply = [];
        const redoRev: Op[][] = [];
        for (const sid of status.pendingSids) {
          const cur = locate(s, sid);
          const curStop = s.stops[sid];
          const removeHere: Op = cur.day === 0 ? { t: "removeCand", sid } : { t: "removeFromDay", sid };
          const reinsertHere: Op = cur.day === 0
            ? { t: "insertCand", sid, index: cur.index }
            : { t: "insertDay", sid, day: cur.day, index: cur.index };
          const old = snapshot.stops[sid];
          if (old) {
            let oldLoc: Op | null = null;
            for (let d = 0; d < snapshot.days.length; d++) {
              const i = snapshot.days[d].stops.indexOf(sid);
              if (i >= 0) { oldLoc = { t: "insertDay", sid, day: d + 1, index: i }; break; }
            }
            if (!oldLoc) {
              const ci = snapshot.candidates.indexOf(sid);
              oldLoc = { t: "insertCand", sid, index: ci >= 0 ? ci : snapshot.candidates.length };
            }
            inverseToApply.push(removeHere, { t: "delStop", sid }, { t: "addStop", sid, stop: old }, oldLoc);
            redoRev.push([
              { t: "removeFromDay", sid }, { t: "removeCand", sid }, { t: "delStop", sid },
              { t: "addStop", sid, stop: { ...curStop } }, reinsertHere,
            ]);
          } else {
            inverseToApply.push(removeHere, { t: "delStop", sid });
            redoRev.push([{ t: "addStop", sid, stop: { ...curStop } }, reinsertHere]);
          }
        }
        redo = redoRev.reverse().flat();
      } else if (hasSids && !snapshot) {
        inverseToApply = entry.inverse.filter((op) => {
          const sid = "sid" in op ? op.sid : "from" in op ? op.to : undefined;
          return sid === undefined || still.has(sid as Sid) || [...still].some((x) => resolveSid(s, x) === sid);
        });
        redo = entry.ops.filter((op) => {
          const sid = "sid" in op ? op.sid : "from" in op ? op.from : undefined;
          return sid === undefined || still.has(sid as Sid);
        });
      } else {
        inverseToApply = entry.inverse;
        redo = entry.ops;
      }
      commit(
        {
          op: "revert",
          summary: `reverted ${editId}${status.keptSids.length ? ` (${status.keptSids.map((x) => `[${x}]`).join(" ")} accepted and kept)` : ""}`,
          ops: inverseToApply,
          inverse: redo,
        },
        actor,
      );
      markFate(editId, "reverted");
      return { reverted: status.pendingSids, kept: status.keptSids };
    },

    /** One undo history for both actors: pop the top log entry, apply its inverse.
     *  Deliberate tradeoff (§5 "ONE undo stack = the log"): a popped entry
     *  vanishes from the change feed, so a human Ctrl+Z is not narrated to the
     *  agent — the always-present PENDING section and full-state reads keep the
     *  agent's next look truthful. */
    undo(): { undone: string } | { error: string } {
      const s = get();
      const entry = s.log[s.log.length - 1];
      if (!entry) return { error: "nothing to undo." };
      let next = applyOps(s, entry.inverse);
      next = { ...next, log: next.log.slice(0, -1), rev: next.rev + 1 };
      store.setState(next, true);
      deps.afterCommit?.(next, "human");
      return { undone: entry.summary };
    },

    newTrip(): void {
      store.setState(initialTrip(), true);
      deps.afterCommit?.(get(), "human");
    },

    // ── non-commit state ───────────────────────────────────────────────────
    setResolvingPins(pins: ResolvingPin[]): void {
      store.setState({ resolvingPins: pins });
    },
    advanceAgentRead(): void {
      store.setState({ lastAgentReadRev: get().rev });
    },
  };

  // Fate annotations live on the ORIGINAL agent entry so get_changes can print
  // per-edit fates even after marks are gone.
  function markFate(editId: Eid, fate: "accepted" | "reverted"): void {
    const s = get();
    const log = s.log.map((e) => (e.editId === editId && e.actor === "agent" ? { ...e, fate } : e));
    store.setState({ log });
  }

  return { store, actions, commit };
}

// ── derived queries (pure, exported for tools and UI) ─────────────────────
export function editStatus(s: TripState, editId: Eid): EditStatus | null {
  const entry = s.log.find((e) => e.editId === editId && e.actor === "agent");
  if (!entry) return null;
  const sids = entry.sids ?? [];
  const pendingSids: Sid[] = [];
  const keptSids: Sid[] = [];
  for (const orig of sids) {
    const cur = resolveSid(s, orig);
    if (cur && s.stops[cur]?.pending === editId) pendingSids.push(cur);
    else if (cur) keptSids.push(cur);
  }
  let fate: EditStatus["fate"];
  if (entry.fate === "reverted") fate = "reverted";
  else if (sids.length > 0) {
    if (pendingSids.length === sids.length) fate = "pending";
    else if (pendingSids.length === 0) fate = "accepted";
    else fate = "partial";
  } else {
    fate = entry.fate ?? "pending";
  }
  return { editId, entry, fate, pendingSids, keptSids };
}

export function pendingEdits(s: TripState): EditStatus[] {
  const out: EditStatus[] = [];
  for (const e of s.log) {
    if (e.actor !== "agent" || !e.editId) continue;
    if (e.op === "revert" || e.op === "accept") continue; // fate events are not reviewable edits
    const st = editStatus(s, e.editId);
    if (st && (st.fate === "pending" || st.fate === "partial")) out.push(st);
  }
  return out;
}

/** Hash of the placed set (day stops' places + lodging anchors; candidates excluded). */
export function placedHash(s: TripState): string {
  const pids = new Set<Pid>();
  for (const d of s.days) for (const sid of d.stops) pids.add(s.stops[sid].place);
  for (const n of s.nights) if (n) pids.add(n);
  return [...pids].sort().join(";");
}
