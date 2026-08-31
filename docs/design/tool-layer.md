# tripcanvas — Final WebMCP tool layer & store contract

Skeleton: Design B (demo) store contract with by-id inverses and [s#]/[c#] addressing. Grafted: Design A's depth pair (get_changes, revert_pending), rev cursor, matrix-hash policy, replace-guard, matrix persistence; Design C's timeout guard, merged set_times, REFUSED discipline. The B/C progressive-commit-vs-atomic contradiction is resolved with an ephemeral pin layer (below).

## 1) Final tool table

| # | name | readOnly | untrusted | purpose |
|---|------|----------|-----------|---------|
| 1 | get_itinerary | true | true | Read whole trip + human-changes-since-last-read + pending list; `day` param paginates |
| 2 | get_changes | true | true | Revision-by-revision diff with edit fates (pending/accepted/reverted) |
| 3 | plan_trip | false | true | Plan whole trip from ≤12 names (flat+dayCount OR pre-grouped days); one pending batch |
| 4 | add_place | false | true | Resolve one name → stop (best insertion) or candidate |
| 5 | move_stop | false | false | Move/reorder stop, candidate→day, day 0→candidates (covers remove) |
| 6 | set_times | false | false | dayStart / dwell / free-time knobs for one day |
| 7 | set_leg_mode | false | true | walk/drive/transit per leg; transit fetches MOTIS steps |
| 8 | set_lodging | false | true | Resolve lodging, anchor nights (per-night model) |
| 9 | arrange_days | false | false | Recluster + reorder whole trip; same function as the human button |
| 10 | revert_pending | false | false | Agent cleans up its own unaccepted edits only |
| 11 | get_planning_guide | true | false | Static planning judgment: dwell by kind, pacing, meals, closed-day cautions |

Names: all ≤14 chars, `[a-z_]`. Descriptions measured 330–486 chars. Every `execute` returns a string; failures are explanatory `ERROR: ...` strings; tools are never unregistered.

## 2) Registration text per tool

**get_itinerary** — readOnlyHint: true, untrustedContentHint: true (Nominatim names, human text)
> Read the whole trip: each day's ordered stops with arrival times, dwell, leg mode and minutes, lodging per night, candidates (places on no day), and warnings (past-22:00 overflow, legs over 40 min). Every read also lists what the human changed since your last read and which of your edits are still pending review. Call it before editing and again after the human touches the map. Stops are addressed by the [s#]/[c#] ids it prints. Pass day for one day in full detail on long trips. *(483)*

- inputSchema: `{ day?: number "1-based day to read alone in full detail. Omit for the whole trip; trips over 4 days auto-compact to per-day one-liners." }`
- result: the handback (section 4). If full text would exceed 1,400 chars: header + one line per day (`DAY 2 09:00-14:53 4 stops: Meiji Shrine -> ... -> Shinjuku Gyoen`) + `Pass day:N for stop detail`; header, HUMAN CHANGES and YOUR PENDING EDITS sections are ALWAYS included, so a re-read is never empty. Empty trip: `Trip is empty — use plan_trip or add_place.` Reading advances the agent's read cursor (bookkeeping only; readOnlyHint stays honest).

**get_changes** — readOnlyHint: true, untrustedContentHint: true (summaries carry place names)
> List every change since a revision: who made it (human or agent), what changed, and the fate of each of your edits — pending, accepted, or reverted. Defaults to everything since your last get_itinerary or get_changes call. Use it after a pause to see what the human did, and before building on your own pending edits. Returns 'No changes since rev N.' when quiet; if the revision is older than kept history it returns the full itinerary instead. *(445)*

- inputSchema: `{ since?: number "Revision to list changes after (from an earlier result). Default: your last read." }`
- result: one line per log entry: `rev43 human: moved [s7] D2 pos4 -> pos3`, `rev44 human: reverted your e9 ([s2] restored)`, `rev45 agent e11: leg into [s5] -> transit [pending]`. Footer: `Pending now: e11 ([s5]), e12 ([s8])`. `since` older than kept history (200 entries): `History starts at rev 30; full state instead:` + itinerary. Never errors; an empty diff is a normal string.

**plan_trip** — readOnlyHint: false, untrustedContentHint: true
> Plan a whole trip from place names. Give places plus dayCount, or days you grouped yourself (grouping kept; each day is still ordered by travel time). Max 12 names per call including lodging — resolving is rate-limited (~1/s). The page resolves names, assigns days, orders each day from its lodging, and computes a timed schedule. Unresolved names are skipped and listed, never fatal. Everything lands pending until the human reviews it. Overwriting an existing trip needs replace:true. *(486)*

- inputSchema:
```
{ places?: string[]   "Flat place names, e.g. 'Ghibli Museum, Mitaka'. Use with dayCount, or give days instead. 12 names max incl. lodging."
  days?: string[][]   "Pre-grouped names, one inner array per day. Grouping kept; each day still reordered by travel time."
  dayCount?: number   "Number of days, 1-7. Required with places; ignored with days."
  lodging?: string    "Lodging name, applies to all nights. Per-night lodging: set_lodging afterwards."
  dayStart?: string   "HH:MM start for every day. Default 09:00."
  replace?: boolean   "Must be true to overwrite an existing trip." }
```
- result: `Planned 3 days, 10 stops (9 fresh, 1 cached) — all pending as e12; the human is reviewing on the map. D1 09:00-16:03: Senso-ji, Tokyo NM, Ueno Park, Akihabara. D2 ... Unresolved (not added): 'Ryogoku sumo hall' — retry a fuller name via add_place. Warnings: none.` Errors: `ERROR: 15 names exceeds the 12-per-call cap (resolving is rate-limited to 1/s) — plan the 12 most important, add the rest with add_place.` / `ERROR: a trip exists (rev 47) — pass replace:true or edit it instead.` / `ERROR: only 1 name resolved — trip unchanged.` Internal deadline breach: plans what resolved, lists the rest as `not resolved (time limit)`.

**add_place** — readOnlyHint: false, untrustedContentHint: true
> Resolve one free-text place name and add it: to a day at the best position by travel time (or a fixed position), or as a candidate when day is omitted. Takes about 1s for an uncached name. Returns the resolved name — check it matches what you meant; if wrong, move it to candidates and retry with a fuller name like 'Ghibli Museum, Mitaka'. The stop lands pending for the human. *(378)*

- inputSchema: `{ name: string "Free-text place name; include the city for accuracy.", day?: number "1-based target day; omit to add as a candidate.", position?: number "1-based slot in the day; omit for best insertion by travel time.", dwellMinutes?: number "Minutes at the stop. Default 60." }`
- result: `Added [s11] Ghibli Museum (Mitaka) to D2 pos3, dwell 60 [pending e13]. D2 now ends 19:40, no overflow.` Candidate: `Added [c3] Ghibli Museum as a candidate [pending e13].` Errors: `ERROR: no place found for 'X' — add a city or landmark to the name.` / `ERROR: 'Tokyo' resolved to a whole city — name a venue.` / `ERROR: day 5 out of range (trip has 3).`

**move_stop** — readOnlyHint: false, untrustedContentHint: false (ids and times only)
> Move a stop to another day or position, place a candidate onto a day, or pass day 0 to unassign a stop into candidates (nothing is deleted; candidates keep it recoverable). Omit position for best insertion by travel time. Ids come from get_itinerary. Affected days reschedule immediately; the result reports their new end times and any overflow. Pending until the human accepts or reverts. *(389)*

- inputSchema: `{ stop: string "[s#] or [c#] id from get_itinerary.", day: number "Target day 1..N, or 0 to send it to candidates.", position?: number "1-based slot; omit for best insertion by travel time." }`
- result: `Moved [s3]: D1 pos3 -> D2 pos1 [pending e14]. D1 ends 15:10; D2 ends 20:05, no overflow.` / `Unassigned [s9] to candidates as [c3] [pending e15]; D3 ends 12:40.` Errors: `ERROR: no stop [s99] — ids come from get_itinerary.` / `ERROR: day 6 out of range (trip has 3).`

**set_times** — readOnlyHint: false, untrustedContentHint: false
> Set a day's timing inputs: dayStart (HH:MM) moves when the day leaves its lodging; stop plus dwellMinutes changes minutes spent there; freeMinutesAfter inserts unscheduled time after that stop. The schedule recomputes at once. Use when get_itinerary warns a day overflows past 22:00 — start earlier or trim dwell. Pending until the human accepts. *(346)*

- inputSchema: `{ day: number "Day 1..N.", dayStart?: string "New HH:MM 24h start for the day.", stop?: string "[s#] id to retime; required with dwellMinutes or freeMinutesAfter.", dwellMinutes?: number "New minutes spent at the stop.", freeMinutesAfter?: number "Unscheduled minutes after the stop; 0 removes the block." }`
- result: `[s8] dwell 60 -> 90 [pending e16]. D2 ends 14:34.` / `D2 starts 14:00. Ends 22:40 — WARNING: past 22:00.` Errors: `ERROR: give dayStart, or stop with dwellMinutes/freeMinutesAfter.` / `ERROR: time must be HH:MM 24h.` / `ERROR: no stop [s99].`

**set_leg_mode** — readOnlyHint: false, untrustedContentHint: true (MOTIS line/headsign text)
> Set how one leg is travelled: walk, drive or transit. Name the leg by the stop it departs from ([s#] id; 'lodging' for a day's first leg). Legs default to walk under about 1.2 km and drive above — call this only to override. transit fetches live routes (a few seconds) and returns the steps: lines, headsigns, where to get off. If no transit route exists the leg keeps its old mode and the result says so. Pending. *(414)*

- inputSchema: `{ day: number "Day 1..N containing the leg.", fromStop: string "[s#] id the leg departs from, or 'lodging' for the day's first leg.", mode: string "walk | drive | transit." }`
- result: `Leg [s2]->[s3] transit 28m, 1 transfer [pending e17]: walk 4m to Ueno Sta; Ginza Line toward Shibuya, off at Tawaramachi; walk 6m. D1 ends 16:20.` / `Leg [s2]->[s3] drive 11m [pending e17]; D1 ends 15:58.` Errors: `ERROR: no transit route found — leg stays walk (35m).` / `ERROR: transit service unreachable — mode unchanged, try again.` / `ERROR: [s4] is the last stop of D2 — its leg is the return to lodging; use fromStop [s4] only if a next stop exists.`

**set_lodging** — readOnlyHint: false, untrustedContentHint: true
> Resolve a lodging name and anchor nights to it. Night 0 is where Day 1 starts; night N is where day N ends and day N+1 starts. Omit nights to set every night. Day schedules recompute from their anchors; days with no lodging start at their first stop. Returns the resolved name — verify it matches. Pending until the human accepts. *(330)*

- inputSchema: `{ name: string "Lodging name or address; include the city.", nights?: number[] "Night numbers to anchor; omit for every night." }`
- result: `Hotel Gracery Shinjuku anchored for nights 0-2 [pending e18]. All days start/end there. D1 ends 16:03, D2 14:53, D3 13:30.` Errors: `ERROR: no place found for 'X' — try a fuller name.` / `ERROR: night 4 out of range (nights 0-2).`

**arrange_days** — readOnlyHint: false, untrustedContentHint: false (ids and times only)
> Regroup and reorder every placed stop across days by travel time: stops cluster into days, each day is ordered from its lodging, schedules recompute — exactly what the human's Arrange days button does. Dwell survives; leg-mode choices survive where the stop pair stays adjacent. Candidates untouched. Pass dayCount to grow or shrink the trip. Use after several adds rather than optimising stop by stop. One pending edit, one-click revert. *(438)*

- inputSchema: `{ dayCount?: number "Target number of days 1-7; omit to keep the current count." }`
- result: `Arranged 3 days [pending e19]. D1 [s1 s2 s3 s4] ends 16:03. D2 [s5 s6 s7 s8] ends 14:53. D3 [s9 s10] ends 13:30. Candidates untouched: 2. Overflow: none; legs over 40m: none.` Errors: `ERROR: fewer than 2 stops — nothing to arrange.` Matrix refresh failure: arranges on estimates, appends `times approximate — routing service unreachable`.

**revert_pending** — readOnlyHint: false, untrustedContentHint: false
> Revert your own pending edits — ones the human has not yet accepted or built on. Pass edit ids from get_changes, or all:true for every pending edit of yours. An edit whose stops the human already touched is accepted and stays; the rest of the edit is restored exactly. Never touches human-made changes; ask the human to undo those instead. *(339)*

- inputSchema: `{ edits?: string[] "Pending edit ids from get_changes, e.g. ['e12'].", all?: boolean "Revert every pending edit of yours." }`
- result: `Reverted e13, e14; rev now 52. 1 edit still pending (e17).` / partially accepted batch: `e12: 3 of 4 stops reverted; [s8] was accepted by the human and stays.` Errors: `ERROR: e9 was fully accepted — ask the human to undo.` / `ERROR: no pending edits.`

**get_planning_guide** — readOnlyHint: true, untrustedContentHint: false (static text authored by the page)
> Read once before planning or filling a trip: typical minutes to spend at different kinds of places, how many stops make a comfortable day, and when to leave free time for meals. Use it to choose dwellMinutes for add_place and set_times and to decide how much to pack into a day. Static text — the live trip comes from get_itinerary. *(342)*

- inputSchema: `{}` (no parameters)
- result (static, ~1,000 chars):
```
PLANNING GUIDE (static)
Dwell minutes by kind (default is 60 when you omit dwellMinutes):
temple/shrine 40-60; large museum 90-150; small museum/gallery 60-90;
market/street 60-90; park/garden 45-75; viewpoint/landmark 20-40;
theme park 240+; meal stop 60-90.
Pacing: 3-5 stops/day is comfortable; arrange caps 5 per day (extras become candidates); days past 22:00 are flagged.
Meals: the page never schedules meals. Add free time 60-90 min around 12:00-13:30 and 18:00-20:00 with set_times freeMinutesAfter, or add a restaurant as a stop.
Closed days: the page does NOT check opening hours — use your own knowledge (e.g. many Tokyo museums close Mondays) and warn the human when unsure.
Legs default to walk <=1.2 km, drive above; suggest transit via set_leg_mode where it beats driving.
After the human edits the map, re-read get_itinerary before building on your own edits.
```
Rationale (owner decision, 2026-08-31): judgment rules the code cannot own travel through the agent's parameters; this tool is where the agent learns that judgment — the WebMCP-native replacement for the predecessor's skill-prompt.

## 3) plan_trip flow + timing math

Flow (one synchronous execute, atomic commit):
1. zod-validate. Count resolve jobs = unique uncached names (places or flattened days, + lodging). Hard cap 12 total — over cap returns the error naming the math, no partial run. Existing trip and no `replace:true` → error naming current rev.
2. Resolve lodging first (seeds clustering), then places, serially through the ONE app-wide Nominatim queue: min 1.1s spacing, `email=tillmac.sun@gmail.com`, shared with the human search box; localStorage geocache hit = 0s and no queue slot. Per request: **3s fetch timeout + one retry**, and a **22s wall-clock deadline checked before every request and every retry** — on breach, stop resolving, plan with what resolved, list the rest. Gates per name: resolve-success + excluded-type; failures collected, never fatal (≥2 resolved proceeds, else `trip unchanged` error).
3. During resolution, each resolved place is pushed to an **ephemeral `resolvingPins` slice** (dashed pins on the map, not trip state, no log entry, not persisted; cleared on commit or error). This gives B's progressive pin-drop footage with A's atomic apply — a timeout strands nothing, and undo history matches what the human watched. (Resolves the B/C step-2-vs-step-6 contradiction.)
4. Two OSRM `/table` calls (walk + drive) in parallel over all resolved places + lodging, ~2s, awaited inline.
5. Grouping: `days[][]` honoured verbatim; else farthest-first seeds + k-means-ish into dayCount groups. Per day: greedy nearest-neighbour from the night's lodging anchor + 2-opt. Leg modes by the 1.2 km threshold. Schedule from dayStart (default 09:00), dwell 60, 22:00 overflow flag. Pure JS, <50ms.
6. Commit as **ONE ActionGroup** (one rev, one batchId `e12`, one undo step); every stop pending, source plan_trip; map switches pins from resolving to pending style with the Accept all / Revert banner + provenance note.
7. Return summary string.

Timing math. Worst case, 12 cold names: 11 intervals × 1.1s + ~0.4s last response ≈ **12.5s** Nominatim + **2s** OSRM + **<0.1s** compute ≈ **14.6s** — inside 30s with ~15s margin. Pathological ceiling: deadline check passes at 21.9s → that fetch runs its full 3s timeout → 24.9s, retry skipped (deadline passed), + 2s OSRM + slack ≈ **27s < 30s**. This is why the deadline is 22s, not 25s (judge finding: 25s + 5s timeout + 2s OSRM can total 32s). Typical demo with warm geocache: **<3s**. Above cap: explicit error; extras via add_place at ~1.1s each. Lodging: single all-nights name (per-night via set_lodging); omitted → days start at their first stop and the result says `No lodging set — set_lodging to anchor days.` A replace is itself one pending, undoable group — the old trip is one revert away.

## 4) get_itinerary sample (3 days / 10 stops — measured 1,106 chars)

```
TRIP rev47 — 3 days, 10 stops, 2 candidates. Lodging all nights: Hotel Gracery Shinjuku.
Marks: * = your pending edit
DAY 1 09:00 from lodging
[s1] Senso-ji Temple 09:10-10:40 d90 |walk10|
[s2] Tokyo National Museum 10:52-12:52 d120 |walk12|
[s3] Ueno Park 13:00-14:00 d60 |walk8|
[s4] Akihabara Electric Town 14:15-15:45 d90 |drive15| back drive18 — ends 16:03
DAY 2 09:00 from lodging
[s5] Meiji Shrine 09:24-10:39 d75 |transit24*|
[s6] Takeshita Street 10:51-11:51 d60 |walk12|
[s7] Shibuya Crossing 12:06-12:51 d45 |walk15|
[s8] Shinjuku Gyoen* 13:11-14:41 d90 |drive20| back drive12 — ends 14:53
DAY 3 09:00 from lodging
[s9] teamLab Planets 09:25-11:25 d120 |drive25|
[s10] Tsukiji Outer Market 11:40-13:10 d90 |drive15| back drive20 — ends 13:30
Candidates: [c1] Ghibli Museum, [c2] Odaiba Seaside Park
Warnings: none (no day past 22:00, no leg over 40 min)
HUMAN CHANGES since your last read (rev41):
- moved [s7] Shibuya Crossing D2 pos4 -> pos3 (accepted your e8)
- set [s7] dwell 60 -> 45
- reverted your e9 (add of Big Wheel)
YOUR PENDING EDITS (2): e11 leg into [s5] -> transit; e12 added [s8]
```

Line grammar: id, name, arrival-departure, dwell, `|mode+minutes|` of the ARRIVING leg (first stop's leg departs lodging); `back` = return leg to the night's anchor; `*` = agent edit still pending. Pagination: >1,400 chars or >4 days → day blocks collapse to one-liners + `Pass day:N for stop detail`; `get_itinerary{day:N}` returns that day full-size; header, HUMAN CHANGES and YOUR PENDING EDITS always included. How the agent learns human changes: the store keeps `lastAgentReadRev`, advanced by every get_itinerary/get_changes; the HUMAN CHANGES section renders human-actor log entries (plus accept/revert events on agent edits) with rev > cursor, coalesced per stop (moves collapse to origin→final). The always-present PENDING section hedges the consumed-cursor confusion; `get_changes{since}` is the explicit escape hatch and names each pending edit's fate.

## 5) Store contract

**State** (one zustand vanilla store — tools live outside React and need getState/subscribe; plain TS, no immer):
```ts
{ rev: number,
  places: Record<Pid, {id, name, lat, lon, query}>,
  days: Array<{ start: string /*HH:MM*/, stops: Sid[] }>,
  nights: (Pid|null)[],           // nights[0..D-1]; night 0 starts Day 1, night d ends day d
  stops: Record<Sid, { place: Pid, dwellMin: number, freeAfterMin: number, pending?: Eid }>,
  candidates: Sid[],              // explicit list (see cut list re: derived)
  legOverrides: Record<`${Pid}>${Pid}`, { mode, transit? }>,  // pair-keyed; silently inert when pair separates
  matrices: { walk?, drive?, forHash: string, stale: boolean },
  log: Array<{ rev, actor: 'human'|'agent', op, summary: string, inverse: Op[], editId?, fate?: 'accepted'|'reverted' }>,  // cap 200
  lastAgentReadRev: number,
  resolvingPins: {name, lat, lon}[],  // ephemeral: UI only, never logged or persisted
  endLastDayAtLodging: boolean }      // human-only toggle on the last day (default true); no tool param in v1; get_itinerary prints which is active
```
Schedule is derived per render (ported pure fn), never stored.

**Actions / undo / pending.** Every mutation — button or tool — goes through one `commit(group, actor)`: build ops + **by-id hand-written inverse ops** (not positional patches — see cut list) → apply → rev++ → append log entry with a human-readable summary (this is what get_changes prints, written once at commit time) → if actor=agent, assign editId and mark touched stops pending → debounced persist → matrix hash check. ONE undo stack = the log; Ctrl+Z applies the top entry's inverse regardless of actor (ADR-0004). Accept = clear mark + log a fate event. Human dispatch touching a pending stop clears its mark first (implicit accept, logged) — so revert only ever touches human-untouched items and cannot conflict. `revert(editId)` applies inverses of that group's still-pending members, logs it as a new group (undoable), reports members kept because accepted.

**Matrix refresh** (the old bug, fixed by policy): trigger = hash of sorted placed-place ids (day stops + lodging anchors; candidates excluded) differs from `matrices.forHash` after any commit — reorders and cross-day moves don't change the set, so refreshes stay rare. Human-driven: 500ms trailing debounce. Tool executes that changed the set: flush immediately and await the fetch inline so returned times are real; plan_trip/arrange_days await any in-flight fetch rather than compute on estimates. One OSRM `/table` per mode, walk+drive in parallel. While stale: haversine × mode-speed estimates, UI shows `≈` and handback appends `times approximate — matrix refreshing`. Fetch failure: keep the old matrix when it covers a superset, else estimates + a note; page stays editable (ADR-0001). Matrix arrival is derived data: recompute schedules, no rev bump, no log entry.

**Seam.** `src/webmcp/registerItineraryTools.ts` exports `registerItineraryTools(store)`, called ONCE at module scope in `main.tsx` before `createRoot` — StrictMode double-mount cannot re-run module scope; a module-level `registered` flag guards HMR (register-once, no AbortSignal reliance). Feature-detect `typeof document.modelContext?.registerTool === 'function'`; else `store.agentAvailable = false` and the page runs human-only with a banner. Each tool's execute is a thin adapter: zod-parse → the SAME exported action the UI button imports (Arrange button and arrange_days both call `actions.arrange()`; search-box Enter and add_place share `actions.resolveAndAdd()`; buttons pass actor:'human', tools 'agent') → handback formatter → string. Try/catch everywhere → `ERROR: ...` strings; never unregister.

**Persistence.** localStorage: `tripcanvas:trip:v1` (state minus matrices/resolvingPins, log trimmed to 200) debounced 250ms on rev change; `tripcanvas:geocache:v1` normalized query → place (the policy-required Nominatim cache, shared with the search box); `tripcanvas:matrix:<hash>` per coord-set so a reload with an unchanged place set skips OSRM (~5 lines, hash already exists). Boot: zod-parse; corrupt → fresh trip.

## 6) Cut list

- **remove_place** (C) — move_stop day 0 keeps removals recoverable as candidates; one fewer tool.
- **Display-name stop addressing** (C) — accents/paraphrase/typos are an on-camera `no place named X` loop; [s#] ids cost nothing.
- **Immer produceWithPatches inverses** (A) — positional array patches corrupt on out-of-order revert after later inserts; by-id hand-written inverses instead.
- **Selective revert deeper than "still-pending members by stored inverse"** (A/C) — partial-inverse surgery on accepted state is untestable machinery; implicit accept already guarantees no conflict.
- **Derived candidates** (A) — with an explicit list plus the ephemeral resolvingPins layer, mid-call resolve orphans can never flash into the candidates panel; one plain array is boring and safe.
- **Mid-call store commits during plan_trip** (B/C) — replaced by the ephemeral pin layer + one atomic ActionGroup; fixes the progressive-vs-one-log-entry contradiction both carried.
- **set_day_start + update_stop as separate tools** (B) — merged into set_times; same knobs, one schema.
- **A's 14-name cap (12+2)** — 12 total including lodging; one number, cleaner error math.
- **A's 25s deadline / B's no deadline** — 22s deadline + 3s fetch timeout, so the pathological ceiling is ~27s, not ~32s.
- **resolve_place search tool, agent-side accept/undo, get_transit_options browse, start-and-poll planning** (C's REFUSED list, adopted as scope contract) — add_place already returns what it resolved; review is the human's half of ADR-0004; transit detail is the result of switching a leg; plan_trip fits 30s synchronously.
- **exposedTo / toolchange / declarative forms / iframe tools / AbortSignal-unregister** — unsupported or unverified in ChatGPT; banned from core behaviour per the research file.

## 7) Decisions resolved in review (2026-08-31, product owner)

1. **Last day's end** — the human chooses per trip: a toggle on the last day, "end at lodging" (default) or "end at last stop" (skips day D's return anchor). No tool parameter in v1; get_itinerary prints which is active.
2. **Depth pair** — get_changes + revert_pending both stay; if the schedule slips, cut revert_pending first.
3. **plan_trip lodging** — single all-nights string; per-night lodging via set_lodging.
4. **Partially accepted batch revert** — revert still-pending members, report accepted ones as kept.
5. **Leg overrides** — pair-keyed with silent fallback to the distance default when the pair separates; one line of UI copy + the arrange_days description explain it.
6. **Planning guidance** — judgment rules live in the read-only get_planning_guide tool (tool 11); code keeps the invariants (5-stop arrange cap, 1.2 km walk/drive threshold, 22:00 overflow, 40-min leg warning, dayCount required). Demo city: Tokyo (transitous verified: 11 itineraries, rail; Kyoto has no feed). Per-night lodging model confirmed.

Assumptions carried: per-night model as flagged (nights[0..D-1], confirmed 2026-08-31); one agent session at a time (single lastAgentReadRev cursor; `since` is the escape hatch); ChatGPT ignores unknown registerTool fields, so untrustedContentHint is always safe to pass; `email=` is the build-time constant NOMINATIM_EMAIL = tillmac.sun@gmail.com (owner-approved for public source, 2026-08-31); demo rehearsed once so the geocache is warm (~3s plan_trip on camera) in a MOTIS-covered city. Risks carried: app-wide 1 rps Nominatim under concurrent judges (queue + cache + switchable endpoint constant); undocumented ChatGPT timeout (27s ceiling is the mitigation); OSM service outage during judging degrades to `≈` estimates but never blocks editing (ADR-0001); prompt injection via resolved names and MOTIS headsigns reaches the agent by design — untrustedContentHint marks exactly those tools.
