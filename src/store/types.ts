// Store contract per docs/design/tool-layer.md §5. Vocabulary: CONTEXT.md.
import type { DurationMatrix } from "../ported/osrm.js";
import type { TransitLeg } from "../ported/motis.js";

export type Pid = string; // place id, "p1"...
export type Sid = string; // stop/candidate id, "s1"/"c1" — prefix reflects current role
export type Eid = string; // pending-edit id, "e1"...
export type Actor = "human" | "agent";
export type LegMode = "walk" | "drive" | "transit";

export interface Place {
  id: Pid;
  name: string;
  lat: number;
  lon: number;
  /** The free-text query that resolved to this place. */
  query: string;
}

export interface Stop {
  place: Pid;
  dwellMin: number;
  freeAfterMin: number;
  /** Set while this stop carries an unresolved agent edit. */
  pending?: Eid;
}

export interface DayRec {
  /** HH:MM day start. */
  start: string;
  stops: Sid[];
  /** Free time at the start of the day (before the first leg), minutes. */
  freeStartMin?: number;
}

export interface LegOverride {
  mode: LegMode;
  transit?: TransitLeg;
}

export interface Matrices {
  walk?: DurationMatrix;
  drive?: DurationMatrix;
  /** Row/col order: matrices.ids[i] is the place of row i. */
  ids: Pid[];
  /** Hash (sorted placed-place ids) the matrices were fetched for. */
  forHash: string;
  stale: boolean;
}

// ── ops: by-id, hand-written inverses ──────────────────────────────────────
export type Op =
  | { t: "addPlace"; place: Place }
  | { t: "addStop"; sid: Sid; stop: Stop }
  | { t: "delStop"; sid: Sid }
  | { t: "insertDay"; sid: Sid; day: number; index: number }
  | { t: "removeFromDay"; sid: Sid }
  | { t: "insertCand"; sid: Sid; index: number }
  | { t: "removeCand"; sid: Sid }
  | { t: "renameStop"; from: Sid; to: Sid }
  | { t: "setStop"; sid: Sid; patch: Partial<Pick<Stop, "dwellMin" | "freeAfterMin">> }
  | { t: "setPending"; sid: Sid; editId?: Eid }
  | { t: "setDayStart"; day: number; start: string }
  | { t: "setDayFreeStart"; day: number; min: number }
  | { t: "setNight"; night: number; pid: Pid | null }
  | { t: "setLeg"; key: string; value: LegOverride | null }
  | { t: "setEndToggle"; v: boolean }
  | { t: "setTrip"; days: DayRec[]; nights: (Pid | null)[]; candidates: Sid[]; stops: Record<Sid, Stop>; places: Record<Pid, Place>; legOverrides: Record<string, LegOverride> };

export interface LogEntry {
  rev: number;
  actor: Actor;
  /** Machine tag: "add" | "move" | "dwell" | ... | "accept" | "revert". */
  op: string;
  /** Human-readable one-liner, written once at commit time (what get_changes prints). */
  summary: string;
  ops: Op[];
  inverse: Op[];
  /** For agent commits: the edit this entry IS. */
  editId?: Eid;
  /** For accept/revert fate events: the edits this entry resolves. */
  editIds?: Eid[];
  /** Stop/candidate ids this entry touched (final ids, post-rename). */
  sids?: Sid[];
  fate?: "accepted" | "reverted";
}

export interface ResolvingPin {
  name: string;
  lat: number;
  lon: number;
}

export interface TripState {
  rev: number;
  places: Record<Pid, Place>;
  days: DayRec[];
  /** nights[0..D-1]; night 0 starts Day 1, night d ends day d and starts day d+1.
   *  The last day ends at nights[D-1] when endLastDayAtLodging. */
  nights: (Pid | null)[];
  stops: Record<Sid, Stop>;
  candidates: Sid[];
  /** Pair-keyed `${fromPid}>${toPid}`; silently inert when the pair separates. */
  legOverrides: Record<string, LegOverride>;
  matrices: Matrices;
  log: LogEntry[];
  /** Rev before the earliest kept log entry (log capped at 200). */
  historyStartRev: number;
  lastAgentReadRev: number;
  /** Ephemeral: UI only, never logged or persisted. */
  resolvingPins: ResolvingPin[];
  endLastDayAtLodging: boolean;
  /** Old display id -> newer id (role transitions rename s# <-> c#). */
  aliases: Record<string, string>;
  nextS: number;
  nextC: number;
  nextE: number;
  nextP: number;
}

export interface CommitGroup {
  op: string;
  summary: string;
  ops: Op[];
  inverse: Op[];
  /** Final ids touched — agent commits mark these pending; human commits implicitly accept them first. */
  sids?: Sid[];
}

export type EditFate = "pending" | "partial" | "accepted" | "reverted";

export interface EditStatus {
  editId: Eid;
  entry: LogEntry;
  fate: EditFate;
  pendingSids: Sid[];
  /** Members whose pending mark was cleared (accepted) before a revert. */
  keptSids: Sid[];
}
