# tripcanvas

One shared multi-day trip itinerary on a live map, edited by a **human** and a
**browser agent** through the same operations — an entry for the
[WebMCP Challenge](https://webmcp.devpost.com/).

The human drags stops, tunes times, and searches places directly on the
canvas. The agent plans, fills gaps, and fetches transit through **eleven
WebMCP tools** that mutate the exact same store. Agent edits land immediately
but **pending** — highlighted on the map with per-edit revert and accept-all —
and the agent can read back what the human changed since it last looked.

**Live site:** https://tripcanvas.tillmac.com

## Why this use case fits WebMCP

Planning a trip with an AI today is a copy-paste loop: the model writes a text
itinerary, the human re-enters it into a maps app, and neither side ever sees
the other's current version. A trip itinerary is exactly the kind of shared,
structured, spatial state WebMCP was made for: the page holds one live map and
one schedule, and `document.modelContext.registerTool` hands the agent the
same editing operations the human's buttons call. No server, no API keys —
the page *is* the interface for both actors.

## How it improves the user experience

- **One truth.** Agent tool calls mutate the same store the human edits;
  the map and timeline always show the current trip (ADR-0004).
- **Reviewable AI.** Every agent change is applied-but-pending: amber
  highlight, per-edit Revert, Accept all; editing a pending stop accepts it
  implicitly, so review never blocks flow. One undo history covers both.
- **Real schedules, not wish lists.** The page computes place resolution, walk/drive
  matrices, day clustering, ordering, and timed schedules deterministically
  (ADR-0002); the agent contributes names and judgment
  (`get_planning_guide`), never arithmetic.
- **The agent sees the collaboration.** `get_itinerary` returns the timed
  trip *plus* what the human changed since the agent's last read *plus* which
  agent edits are still pending; `get_changes` gives a revision feed with
  per-edit fates (pending / accepted / reverted).

## What people and agents can now do together

Ask your agent to *"plan 3 days in Tokyo"* and watch resolving pins drop onto
the map (`plan_trip`, ≤12 names, one atomic pending batch). Drag a stop to
reorder — the agent reads your correction and reacts. Let it fill a gap
(`add_place`), rebalance days (`arrange_days`, the same function as the
human's button), fix an overpacked evening (`set_times`), switch a leg to
transit and tell you which line to ride and where to get off
(`set_leg_mode`, live MOTIS routes), anchor hotels per night (`set_lodging`),
or clean up after itself (`revert_pending`) — while you keep dragging,
searching, and undoing on the same canvas.

## How WebMCP was implemented

- **Imperative registration only**, once, at module scope in the top-level
  document, before React mounts — StrictMode/HMR-safe, no AbortSignal
  unregistration, feature-detected exactly as OpenAI's docs show
  (`typeof document.modelContext?.registerTool === "function"`); without
  WebMCP the page runs as a plain manual planner with a notice.
- **Eleven tools** (`get_itinerary`, `get_changes`, `plan_trip`, `add_place`,
  `move_stop`, `set_times`, `set_leg_mode`, `set_lodging`, `arrange_days`,
  `revert_pending`, `get_planning_guide`), all inside Chrome's recommended
  budgets (names ≤30, descriptions ≤500, param descriptions ≤150, results
  ≤1,500 chars — enforced by an automated audit test). `readOnlyHint` on the
  read tools; `untrustedContentHint` marks exactly the tools whose results
  carry external text (Nominatim names, MOTIS headsigns).
- **Every tool execute is a thin adapter**: zod-parse → the same exported
  store action the UI button imports → result string. Failures are
  explanatory `ERROR: ...` strings; tools are never unregistered.
- **30-second budget respected**: `plan_trip` resolves ≤12 names serially
  through one app-wide Nominatim queue (≥1.1s spacing, geocache, 3s timeout +
  one retry) under a 22s wall-clock deadline — worst case ≈27s, warm-cache
  reruns a few seconds.
- **Pure static site** (ADR-0001): Nominatim, OSRM and transitous/MOTIS are
  called directly from the browser (all CORS `*`); every failure degrades to
  marked-approximate times or a soft error — the itinerary never blocks.

## Prior work vs. new work

Per ADR-0003, the pure itinerary logic (schedule computation, best-insertion,
geo, OSRM/MOTIS/Nominatim builders+parsers, zod schemas) and the Leaflet map
pane are **ported** from the author's pre-challenge project
`intent-transition-mcp` (a Claude-connector MCP server + widgets, June–July
2026) and live separated in `src/ported/`.

**New work for this challenge (2026-08-25 →):** the entire WebMCP tool layer
(`src/webmcp/`), the headless trip store with its one commit gate, by-id
inverse log (= undo stack = change feed), pending-edit model and [s#]/[c#]
ids (`src/store/`), day clustering + 2-opt arrange, per-night lodging, the
matrix refresh policy, the Nominatim queue, plan_trip orchestration, transit
leg overrides, the handback renderer, and the co-editing canvas UI
(`src/ui/`, `src/App.tsx`).

## Develop

```bash
pnpm install
pnpm dev          # local dev server
pnpm test         # 180+ vitest tests — no real HTTP anywhere
pnpm build        # typecheck + production build
```

## Deploy

Vercel static site. `vercel.json` sends `Origin-Agent-Cluster: ?1` and sets
no restrictive `Permissions-Policy` (both would disable WebMCP). Add the
origin-trial `<meta>` token for the production origin in `index.html`
(trial `WebMCP`, id 4163014905550602241, Chrome 149–156) so the tools work in
stock Chrome without the flag; with the flag
(`chrome://flags/#enable-webmcp-testing`) no token is needed.

## License

MIT — see [LICENSE](LICENSE).
