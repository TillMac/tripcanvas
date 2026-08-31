# Pure static site, no backend

tripcanvas runs entirely in the browser: the page calls Nominatim, OSRM (`routing.openstreetmap.de`), Overpass and MOTIS/transitous directly — all four send `Access-Control-Allow-Origin: *` (verified with `curl -H "Origin: …"` on 2026-08-31). We chose this over a thin proxy because the WebMCP tools must live in the page anyway, a server adds cold-start and uptime risk during the 17-day judging window (2026-09-04 → 09-21), and there is nothing to protect (no keys, no accounts).

## Consequences

Rate limits and outages of the public OSM services hit the demo directly, so every external call must degrade gracefully (show the error, keep the itinerary editable) rather than block the page.
