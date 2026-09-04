// Handback (CONTEXT.md): the plain-text rendering of the whole trip, written
// to be read by an agent. Line grammar per docs/design/tool-layer.md §4.
// T8 layers the HUMAN CHANGES / YOUR PENDING EDITS sections and pagination on
// top of this body; renderHumanTrip (below) is the people-facing variant the
// Copy button uses.
import { fmtHHMM } from "../ported/schedule-ops.js";
import { computeDaySchedule, legKey, tripWarnings, type LegInfo } from "./schedule.js";
import { editStatus, pendingEdits } from "./store.js";
import type { Sid, TripState } from "./types.js";

function legToken(leg: LegInfo, starred: boolean): string {
  return `|${leg.mode}${leg.approx ? "≈" : ""}${leg.minutes}${starred ? "*" : ""}|`;
}

function lodgingLabel(s: TripState): string {
  const named = s.nights.filter((n): n is string => !!n);
  if (named.length === 0) return "No lodging set.";
  const first = named[0];
  if (s.nights.every((n) => n === first)) return `Lodging all nights: ${s.places[first]?.name ?? "?"}.`;
  const parts = s.nights.map((n, i) => `n${i} ${n ? (s.places[n]?.name ?? "?") : "-"}`);
  return `Lodging: ${parts.join("; ")}.`;
}

/** This stop's pending edit: "stop" stars the name; a leg-mode change stars
 *  the leg whose pair key it set (the arriving leg, or the return to lodging). */
function pendingKind(s: TripState, sid: Sid): "stop" | { legKey: string } | null {
  const e = s.stops[sid]?.pending;
  if (!e) return null;
  const entry = s.log.find((x) => x.editId === e && x.actor === "agent");
  if (entry?.op !== "leg") return "stop";
  const op = entry.ops.find((o): o is Extract<typeof o, { t: "setLeg" }> => o.t === "setLeg");
  return op ? { legKey: op.key } : "stop";
}

export function renderDayBlock(s: TripState, day: number): string[] {
  const d = s.days[day - 1];
  const sched = computeDaySchedule(s, day);
  const lines: string[] = [];
  const from = s.nights[day - 1] ? " from lodging" : "";
  lines.push(`DAY ${day} ${d.start}${from}`);
  if (d.freeStartMin) lines.push(`free ${d.start}-${fmtHHMM(sched.startMin + d.freeStartMin)} (${d.freeStartMin}m)`);
  sched.stops.forEach((st, i) => {
    const stop = s.stops[st.sid];
    const place = s.places[stop.place];
    const pk = pendingKind(s, st.sid);
    const starred = (l: LegInfo) => typeof pk === "object" && pk?.legKey === legKey(l.fromPid, l.toPid);
    let line = `[${st.sid}] ${place.name}${pk === "stop" ? "*" : ""} ${fmtHHMM(st.arriveMin)}-${fmtHHMM(st.departMin)} d${stop.dwellMin}`;
    if (st.legIn) line += ` ${legToken(st.legIn, starred(st.legIn))}`;
    const last = i === sched.stops.length - 1;
    if (last) {
      if (sched.backLeg) line += ` back ${sched.backLeg.mode}${sched.backLeg.approx ? "≈" : ""}${sched.backLeg.minutes}${starred(sched.backLeg) ? "*" : ""}`;
      line += ` — ends ${fmtHHMM(sched.endMin)}`;
    }
    lines.push(line);
    if (st.freeAfterMin > 0 && !last) {
      lines.push(`free ${fmtHHMM(st.departMin)}-${fmtHHMM(st.departMin + st.freeAfterMin)} (${st.freeAfterMin}m)`);
    }
  });
  if (sched.stops.length === 0) lines.push("(no stops)");
  return lines;
}

export function renderDayOneLiner(s: TripState, day: number): string {
  const sched = computeDaySchedule(s, day);
  const names = s.days[day - 1].stops.map((sid) => s.places[s.stops[sid].place].name);
  const span = sched.stops.length
    ? `${fmtHHMM(sched.stops[0].arriveMin)}-${fmtHHMM(sched.endMin)}`
    : s.days[day - 1].start;
  return `DAY ${day} ${span} ${names.length} stop${names.length === 1 ? "" : "s"}: ${names.join(" -> ") || "(none)"}`;
}

export function renderWarnings(s: TripState): string {
  const w = tripWarnings(s);
  const parts: string[] = [];
  if (w.overflowDays.length) parts.push(`day ${w.overflowDays.join(", ")} past 22:00`);
  if (w.longLegCount) parts.push(`${w.longLegCount} leg${w.longLegCount > 1 ? "s" : ""} over 40 min`);
  if (w.approx) parts.push("times approximate — routing service unavailable or refreshing");
  return parts.length
    ? `Warnings: ${parts.join("; ")}`
    : "Warnings: none (no day past 22:00, no leg over 40 min)";
}

export function renderHeader(s: TripState): string {
  const stopCount = s.days.reduce((n, d) => n + d.stops.length, 0);
  const endNote = s.days.length > 0 ? ` Last day ends at ${s.endLastDayAtLodging ? "lodging" : "its final stop"}.` : "";
  return (
    `TRIP rev${s.rev} — ${s.days.length} day${s.days.length === 1 ? "" : "s"}, ` +
    `${stopCount} stop${stopCount === 1 ? "" : "s"}, ${s.candidates.length} candidate${s.candidates.length === 1 ? "" : "s"}. ` +
    lodgingLabel(s) + endNote
  );
}

export function renderCandidates(s: TripState): string {
  if (s.candidates.length === 0) return "Candidates: none";
  return `Candidates: ${s.candidates.map((sid) => `[${sid}] ${s.places[s.stops[sid].place].name}${s.stops[sid].pending ? "*" : ""}`).join(", ")}`;
}

/**
 * The trip body: header, day blocks (or one-liners when compact), candidates,
 * warnings. `day` renders a single day in full detail.
 */
export function renderTrip(s: TripState, opts: { day?: number; compact?: boolean } = {}): string {
  if (s.days.length === 0 && s.candidates.length === 0) {
    return "Trip is empty — use plan_trip or add_place.";
  }
  const lines: string[] = [renderHeader(s)];
  if (pendingEdits(s).length > 0) lines.push("Marks: * = your pending edit");
  if (opts.day) {
    lines.push(...renderDayBlock(s, opts.day));
  } else if (opts.compact) {
    for (let d = 1; d <= s.days.length; d++) lines.push(renderDayOneLiner(s, d));
    lines.push("Pass day:N for stop detail");
  } else {
    for (let d = 1; d <= s.days.length; d++) lines.push(...renderDayBlock(s, d));
  }
  lines.push(renderCandidates(s));
  lines.push(renderWarnings(s));
  return lines.join("\n");
}

// ── agent-facing sections (get_itinerary / get_changes, §4) ────────────────

const PAGINATE_OVER_CHARS = 1400;
const PAGINATE_OVER_DAYS = 4;
const MAX_CHANGE_LINES = 8;
/** get_changes shows the oldest N entries and tells the agent where to page from. */
const MAX_FEED_LINES = 15;

/** Human-actor log entries after the agent's read cursor, lightly coalesced:
 *  consecutive moves of the same stop keep only the latest. */
export function humanChangesSince(s: TripState, sinceRev: number): string[] {
  const entries = s.log.filter((e) => e.actor === "human" && e.rev > sinceRev);
  const out: { key: string | null; line: string }[] = [];
  for (const e of entries) {
    const key = e.op === "move" && e.sids?.length === 1 ? `move:${e.sids[0]}` : null;
    if (key) {
      const prev = out.findIndex((x) => x.key === key);
      if (prev >= 0) out.splice(prev, 1);
    }
    out.push({ key, line: `- ${e.summary}` });
  }
  return out.map((x) => x.line);
}

export function renderHumanChanges(s: TripState): string {
  const lines = humanChangesSince(s, s.lastAgentReadRev);
  const head = `HUMAN CHANGES since your last read (rev${s.lastAgentReadRev}):`;
  if (lines.length === 0) return `${head} none`;
  const shown = lines.slice(0, MAX_CHANGE_LINES);
  const more = lines.length - shown.length;
  return [head, ...shown, ...(more > 0 ? [`(+${more} more — get_changes since:${s.lastAgentReadRev})`] : [])].join("\n");
}

export function renderPendingSection(s: TripState): string {
  const pend = pendingEdits(s);
  if (pend.length === 0) return "YOUR PENDING EDITS: none";
  const bits = pend.map((p) => {
    const short = p.entry.summary.length > 48 ? p.entry.summary.slice(0, 45) + "…" : p.entry.summary;
    return `${p.editId} ${short}${p.fate === "partial" ? " (partly accepted)" : ""}`;
  });
  return `YOUR PENDING EDITS (${pend.length}): ${bits.join("; ")}`;
}

// ── human-facing (Copy itinerary) ──────────────────────────────────────────

const mapsLink = (lat: number, lon: number) => `https://maps.google.com/?q=${lat.toFixed(5)},${lon.toFixed(5)}`;
const legText = (leg: LegInfo) => `${leg.mode} ${leg.approx ? "~" : ""}${leg.minutes} min`;

/** Plain itinerary for people: no ids, revs or leg grammar; a maps link per stop. */
export function renderHumanTrip(s: TripState): string {
  if (s.days.length === 0 && s.candidates.length === 0) return "Trip is empty.";
  const stopCount = s.days.reduce((n, d) => n + d.stops.length, 0);
  const lines: string[] = [`${s.days.length}-day trip — ${stopCount} stop${stopCount === 1 ? "" : "s"}`];
  const named = s.nights.filter((n): n is string => !!n);
  if (named.length && s.nights.every((n) => n === named[0])) lines.push(`Lodging: ${s.places[named[0]].name}`);
  else if (named.length) lines.push(`Lodging: ${s.nights.map((n, i) => `night ${i + 1} ${n ? s.places[n].name : "-"}`).join(", ")}`);
  for (let day = 1; day <= s.days.length; day++) {
    const d = s.days[day - 1];
    const sched = computeDaySchedule(s, day);
    const night = s.nights[day - 1];
    lines.push("", `Day ${day} · ${d.start}${night ? ` from ${s.places[night].name}` : ""}`);
    if (d.freeStartMin) lines.push(`  free time ${d.freeStartMin} min`);
    sched.stops.forEach((st, i) => {
      const stop = s.stops[st.sid];
      const place = s.places[stop.place];
      if (st.legIn) lines.push(`  ${legText(st.legIn)}`);
      lines.push(`  ${fmtHHMM(st.arriveMin)}–${fmtHHMM(st.departMin)}  ${place.name} (${stop.dwellMin} min)`, `               ${mapsLink(place.lat, place.lon)}`);
      if (st.freeAfterMin > 0 && i < sched.stops.length - 1) lines.push(`  free time ${st.freeAfterMin} min`);
    });
    if (sched.stops.length === 0) lines.push("  (nothing planned)");
    else if (sched.backLeg) lines.push(`  back to lodging: ${legText(sched.backLeg)} · day ends ${fmtHHMM(sched.endMin)}`);
    else lines.push(`  day ends ${fmtHHMM(sched.endMin)}`);
  }
  if (s.candidates.length) lines.push("", `Not yet scheduled: ${s.candidates.map((sid) => s.places[s.stops[sid].place].name).join(", ")}`);
  if (tripWarnings(s).approx) lines.push("", "~ = estimated travel time");
  return lines.join("\n");
}

/**
 * The full get_itinerary result: trip body (auto-compacted past 4 days or
 * ~1,400 chars unless a single day is requested) + the two agent sections,
 * which are ALWAYS included so a re-read is never empty.
 */
export function renderAgentView(s: TripState, day?: number): string {
  const sections = `${renderHumanChanges(s)}\n${renderPendingSection(s)}`;
  if (s.days.length === 0 && s.candidates.length === 0) {
    return `Trip is empty — use plan_trip or add_place.\n${sections}`;
  }
  if (day !== undefined) {
    if (day < 1 || day > s.days.length) {
      return `ERROR: day ${day} out of range (trip has ${s.days.length}).`;
    }
    return `${renderTrip(s, { day })}\n${sections}`;
  }
  const full = renderTrip(s);
  const body =
    s.days.length > PAGINATE_OVER_DAYS || full.length > PAGINATE_OVER_CHARS
      ? renderTrip(s, { compact: true })
      : full;
  return `${body}\n${sections}`;
}

/** get_changes: revision-by-revision feed with per-edit fates. */
export function renderChanges(s: TripState, since: number): string {
  return changesPage(s, since).text;
}

/** The feed page plus the rev the agent has now seen up to (< s.rev when the page was cut). */
export function changesPage(s: TripState, since: number): { text: string; readTo: number } {
  if (since < s.historyStartRev) {
    return { text: `History starts at rev ${s.historyStartRev + 1}; full state instead:\n${renderAgentView(s)}`, readTo: s.rev };
  }
  const entries = s.log.filter((e) => e.rev > since);
  const pend = pendingEdits(s);
  const footer =
    pend.length === 0
      ? "Pending now: none"
      : `Pending now: ${pend.map((p) => `${p.editId} (${p.pendingSids.map((x) => `[${x}]`).join(" ") || "no stops"})`).join(", ")}`;
  if (entries.length === 0) return { text: `No changes since rev ${since}.\n${footer}`, readTo: s.rev };
  const shown = entries.slice(0, MAX_FEED_LINES);
  const more = entries.length - shown.length;
  const lines = shown.map((e) => {
    // Fate events (the agent's own revert/accept) are not edits: no id to act on.
    if (e.actor === "agent" && e.editId && e.op !== "revert" && e.op !== "accept") {
      const st = editStatus(s, e.editId);
      return `rev${e.rev} agent ${e.editId}: ${e.summary}${st ? ` [${st.fate}]` : ""}`;
    }
    return `rev${e.rev} ${e.actor}: ${e.summary}`;
  });
  const readTo = more > 0 ? shown[shown.length - 1].rev : s.rev;
  if (more > 0) lines.push(`(+${more} more — get_changes since:${readTo})`);
  return { text: [...lines, footer].join("\n"), readTo };
}
