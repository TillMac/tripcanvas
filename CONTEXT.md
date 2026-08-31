# tripcanvas

One shared multi-day trip itinerary on a live map, edited by a human and a browser agent through the same operations. The page is the product; there is no server.

## Actors

**Human**:
The person using the page directly — dragging, clicking, typing.
_Avoid_: user (ambiguous once an agent is also a "user" of the page)

**Agent**:
The browser-side model that edits the trip by calling the page's tools.
_Avoid_: AI, assistant, model, LLM

**Tool**:
One itinerary operation the page exposes to the agent. Every tool does something the human can also do from the page.
_Avoid_: function, endpoint, action

## The trip

**Trip**:
The whole itinerary the page holds: its days and the places known to it.
_Avoid_: plan, route (a route is the path of one leg), itinerary (in code; fine in prose)

**Place**:
A resolved point of interest — a name with coordinates — known to the trip. Stops and lodging anchors are places.
_Avoid_: POI, location, attraction, point

**Stop**:
A place assigned to a day, visited in that day's order.
_Avoid_: item, waypoint, visit

**Lodging anchor**:
The lodging place a day starts from or ends at — the first and last entry of every day, with no dwell. Consecutive days usually share one, but a trip can change hotels.
_Avoid_: hotel (one kind of lodging), start/end point

**Day**:
One calendar day of the trip, numbered from 1: an ordered list of stops between its two lodging anchors.

**Day start**:
The time a day's schedule begins at its lodging anchor.

**Dwell**:
The minutes spent at a stop.
_Avoid_: duration, stay, visit time

**Free time**:
A block of unscheduled minutes placed after a given stop, or at the start of a day.
_Avoid_: break, gap, buffer

**Night**:
The sleep slot between days: night 0 is where Day 1 starts; night d is where day d ends and day d+1 starts. Lodging is anchored per night.
_Avoid_: overnight stay, hotel slot

## Moving between stops

**Leg**:
The travel between two consecutive stops of a day.
_Avoid_: segment, hop, route

**Leg mode**:
How a leg is travelled: `walk`, `drive` or `transit`.
_Avoid_: transport mode, travel mode

**Transit leg**:
The detail of a leg whose mode is transit: total minutes, number of transfers, and its steps.

**Transit step**:
One ride or walk inside a transit leg — a line, its headsign, and where to get off.

**Matrix**:
Pairwise travel durations between all of the trip's places, one matrix per mode (walk, drive). Transit is never a matrix; it is fetched per leg.
_Avoid_: distance matrix (it holds time, not distance)

**Unreasonable leg**:
A leg longer than 40 minutes. A warning, not an error.
_Avoid_: remote leg, far leg

## Derived from the above

**Schedule**:
The computed timeline of a day — arrival and departure times for every stop and free-time block. Derived from day start, dwell, leg modes and the matrix; never edited directly.
_Avoid_: timeline, agenda

**Overflow**:
A day whose schedule ends after 22:00.

**Resolve**:
Turning a free-text place name into a place with coordinates.
_Avoid_: geocode (implementation), search, lookup

**Handback**:
The plain-text rendering of the whole trip, written to be read by an agent.
_Avoid_: export, summary, report

**Provenance**:
The note attached to a plan stating which parts came from routing services and which from the agent, shown as a banner.

## Editing together

**Candidate**:
A place known to the trip but not assigned to any day.
_Avoid_: suggestion, unplaced stop, parking lot

**Pending edit**:
A change the agent made that the human has not yet accepted or reverted. It is applied to the trip immediately and stays marked until resolved.
_Avoid_: draft, staged change, proposal

**Accept**:
Resolving a pending edit by keeping it. Editing a pending stop accepts it implicitly.

**Revert**:
Resolving a pending edit by restoring what it changed.

**Arrange**:
Recomputing day assignment and stop order for the whole trip from travel times — the same operation whether the human clicks it or the agent asks for it.
