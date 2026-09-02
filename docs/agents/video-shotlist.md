# Demo video shot list (<3 min, with narration)

Spec: two halves; the video IS the acceptance test of the feature (issue #1).
Rehearse once first so the geocache is warm (plan_trip ~3s on camera).
Record at https://tripcanvas.tillmac.com in the ChatGPT desktop app's built-in
browser (Site tools arrow visible) — that single frame proves the WebMCP path.

## Cold open (0:00–0:15)
- Empty canvas. One line: "Planning a trip with an AI is a copy-paste loop —
  the model writes text, you re-type it into a maps app."
- "tripcanvas gives the agent the same canvas you use. Same map, same trip."

## Half 1 — agent plans, human corrects, agent reacts (0:15–1:30)
1. Ask the agent: "Plan 3 days in Tokyo with Senso-ji, Tokyo National Museum,
   Ueno Park, Akihabara, Meiji Shrine, Takeshita Street, Shibuya Crossing,
   teamLab Planets, Tsukiji Outer Market; stay at Hotel Gracery Shinjuku."
   → CAMERA: resolving pins dropping one by one, then the whole trip landing
   amber + the "Agent changed…" bar. Narrate: "Everything the agent did is
   pending — my map, my call."
2. Revert ONE edit from the bar; drag one stop to reorder; change a dwell.
   Narrate: "Editing a pending stop accepts it — review never blocks me."
3. Ask the agent: "What did I change?" → it calls get_itinerary and answers
   with your exact edits. Money line: "It reads my corrections."
4. Accept all.

## Half 2 — human builds, agent fills (1:30–2:40)
5. Search a place by hand (Enter), drag a candidate onto a day.
6. Ask: "I have a free afternoon on day 3 — add one place that fits and
   rebalance." → add_place + arrange_days land amber; accept.
7. Ask: "How do I get from Meiji Shrine to Shibuya by transit?" →
   set_leg_mode; CAMERA: line badge + transfers + off-at stop in the
   timeline and the purple route on the map.
8. Ctrl+Z once: "One undo history — mine and the agent's."

## Close (2:40–3:00)
- Copy itinerary → paste somewhere visible: "…and it leaves as text."
- End card: URL + "11 WebMCP tools · pure static page · no backend".

## Checklist before recording
- [ ] Rehearse once (warm geocache), then New trip
- [ ] Chrome/ChatGPT window at 1280×800-ish; hide bookmarks bar
- [ ] Site tools arrow in frame at least once
- [ ] Mic check; narration in English (judges)
