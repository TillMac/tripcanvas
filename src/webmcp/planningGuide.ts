// Static planning judgment (docs/design/tool-layer.md tool 11). The
// WebMCP-native replacement for the predecessor's skill prompt: judgment the
// code cannot own travels through the agent's parameters; this is where the
// agent learns it.
export const PLANNING_GUIDE = `PLANNING GUIDE (static)
Dwell minutes by kind (default is 60 when you omit dwellMinutes):
temple/shrine 40-60; large museum 90-150; small museum/gallery 60-90;
market/street 60-90; park/garden 45-75; viewpoint/landmark 20-40;
theme park 240+; meal stop 60-90.
Pacing: 3-5 stops/day is comfortable; arrange caps 5 per day (extras become candidates); days past 22:00 are flagged.
Meals: the page never schedules meals. Add free time 60-90 min around 12:00-13:30 and 18:00-20:00 with set_times freeMinutesAfter, or add a restaurant as a stop.
Closed days: the page does NOT check opening hours — use your own knowledge (e.g. many Tokyo museums close Mondays) and warn the human when unsure.
Legs default to walk <=1.2 km, drive above; suggest transit via set_leg_mode where it beats driving.
After the human edits the map, re-read get_itinerary before building on your own edits.`;
