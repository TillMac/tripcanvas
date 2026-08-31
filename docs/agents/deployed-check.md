# Scripted WebMCP check against the deployed URL (T10)

Run after every deploy, via chrome-devtools-mcp (or manually in Chrome ≥149
with `chrome://flags/#enable-webmcp-testing` ON). Every step names its
expected output; any deviation is a release blocker.

## Steps

1. **Open** `https://<production-origin>/` in a fresh tab.
2. **Feature detection** — evaluate:
   ```js
   typeof document.modelContext?.registerTool
   ```
   Expect `"function"`. (With the flag OFF, expect `"undefined"` *unless* the
   origin-trial `<meta>` token is present and valid — check both profiles.)
3. **Tool listing** — DevTools → Application → WebMCP. Expect exactly these
   11 tools: `get_itinerary`, `get_changes`, `plan_trip`, `add_place`,
   `move_stop`, `set_times`, `set_leg_mode`, `set_lodging`, `arrange_days`,
   `revert_pending`, `get_planning_guide`.
4. **Execute the read tool** — run `get_itinerary` with `{}` from the panel.
   Expect a string starting `Trip is empty — use plan_trip or add_place.`
   (fresh profile) containing both `HUMAN CHANGES` and `YOUR PENDING EDITS`.
5. **Execute one write tool** — run `add_place` with
   `{"name": "Senso-ji, Tokyo", "day": 1}`... first create a day by running
   `plan_trip` with `{"places": ["Senso-ji, Tokyo", "Ueno Park, Tokyo"], "dayCount": 1}`.
   Expect `Planned 1 days, 2 stops … all pending as e1`; the page shows two
   amber pending stops, the PendingBar, and resolving pins during the call.
6. **Round trip** — run `get_itinerary` again. Expect `TRIP rev1`, the two
   stops with `*` marks, and `YOUR PENDING EDITS (1)`.
7. **Human-only banner** — in a stock profile without flag/token the page
   must render the manual-planner banner and stay fully usable.
8. **Console** — zero errors on load and after steps 4–6.

## Header checks (curl)

```bash
curl -sI https://<production-origin>/ | grep -i origin-agent-cluster   # ?1
curl -sI https://<production-origin>/ | grep -i permissions-policy     # no tools=()
```
