# Sovereign Travellog — Concept

> A private, self-hosted trip planner and personal place check-in log —
> the seam between "plan a trip" (Wanderlog/Wanderlust) and "record where
> I've been" (Swarm), where neither dies the moment the other's use case
> ends. This is the authoritative product concept for phase 1.
> [`SPEC.md`](SPEC.md) holds the technical design and task breakdown;
> [`ROADMAP.md`](ROADMAP.md) the prioritized build order. Originates from
> the Sovereign platform's
> `docs/research/0005-trip-planning-and-place-checkin-plugin.md` — read
> there for the full option analysis and rejected alternatives; this file
> is the settled/proposed product layer that follows from it, updated as
> later concept-review passes settle more of it (most recently: the web UI
> structure and the trip/stop model).

## Product statement

Travellog combines trip planning and a personal place check-in log into one
plugin, built around a single idea:

**Checking in somewhere is always available and stands on its own. A trip
is just an optional folder that check-ins fall into automatically when the
timing matches.**

Wanderlog and Wanderlust both die the day a trip ends. Swarm has no concept
of a future trip at all. Travellog is the seam between them — not a
Frankenstein of both, but the actual underlying lifecycle they only ever
implement one phase of.

## Core model: two spines, joined by time

```
   PLAN SPINE (intentional, future)      LOG SPINE (factual, past)
   ────────────────────────────────      ─────────────────────────
   trip                                  visit  (a check-in)
    └─ stop (place + date range) ┐         ├─ place
        └─ trip_day              │         ├─ happened_at
            └─ itinerary_item ─┐ │         ├─ note, photo(s)
               (planned time)  │ │         └─ trip?  ◀── optional
                                │ │
                                └─┴── soft link ─────┘
                                    (auto: happened_at inside trip's dates)

   Both sides point at the same shared "place."
```

A **visit** is a check-in. A **trip** is an ordered sequence of **stops** —
each a place with its own arrival/departure dates ("starting point, then
other locations in between") — broken into day-by-day itineraries. A trip's
own overall date range is **derived** from its first stop's arrival and its
last stop's departure, never set independently. Visits and trips are
independent — a visit never requires a trip — and join automatically when a
visit's timestamp falls inside the trip's (stop-derived) date range.

### Decided — do not reopen

- **One plugin, one database, one `place` table.** Check-in and trip
  planning are not split across plugins or joined through a cross-plugin
  data contract — that would turn the auto-link into a user-visible consent
  prompt for what should feel like one product's internal behavior, and
  would fork `place` into two reconciling copies.
- **A visit is valid with no trip attached.** Checking in at your local
  café on an ordinary Tuesday is a first-class action. Trips never gate
  check-in, and check-in is never presented as a "trip feature."
- **The auto-link is a suggestion, always overridable.** When a visit's
  timestamp falls inside a trip's date window, Travellog proposes the
  link — it never silently forces it, and correcting it never gets
  clobbered by a later re-derive.
- **No reward mechanics, this phase, full stop.** No coins, streaks,
  badges, mayorship, or leaderboards — not "descoped to a personal
  subset," out entirely. The visit history, the map of everywhere you've
  been, and "you've been here 4 times" are not a watered-down game layer;
  they're the log simply being legible, which is the actual product.
- **An itinerary item can be marked fixed or flexible.** A fixed item (a
  real commitment, e.g. a 7pm dinner reservation) keeps its planned time no
  matter what; a flexible item has no hard commitment. This has standalone
  value in phase 1 (distinguishing "must be at 7pm" from "sometime today"
  while planning) and is also the exact signal a future route-optimization
  pass needs so it never reshuffles a real reservation — see "Future
  (deferred): trip navigation & route optimization," below.

## Phase 1 build order

Three vertical slices, in this order — check-in ships first because it's
the daily-use half; trip planning is used a few times a year.

**Slice 1 — Check-in, visit log, Swarm import.** `place`, `visit`, manual/GPS
check-in with note and photo, the visit history list, a map of visits,
per-place visit counts, and the Swarm ZIP importer. Ships standalone and
useful, and arrives already populated with years of real history instead of
starting empty.

**Slice 2 — Trips, Planner, auto-link.** `trip` (an ordered sequence of
`stop`s, each a place + date range), `trip_day`, `itinerary_item`, the
date-time auto-link back to `visit`, attachments (receipts, booking
confirmations, accommodation details), and optional trip sharing. The
richer "planned vs. actual" comparison view — the thing neither a pure
planner nor a pure check-in log can show on its own — is **deferred**
alongside the full single-page trip-details view it depends on (see
"Deferred, not yet planned," below); Slice 2's web pass ships the basic
trip detail panel instead.

**Slice 3 — Trip Mode (day navigation).** Today's planned schedule, current
position, next stop with a countdown, hand-off to the device's own maps app,
notification reminders, offline-capable.

## Web UI (decided)

Settled via a concept-review pass — do not reopen without cause. **Mobile
UI has not been through the same pass yet** and is intentionally not
specified below (check-in capture and Trip Mode's "Start" are noted as
mobile-only where they come up, but their actual screens are deferred — see
"Deferred, not yet planned" near the end of this file).

### Layout: `ThreeColumnLayout`

Sidebar + main + optional detail column
(`@sovereignfs/ui`'s `ThreeColumnLayout` — the same component and pattern
`sovereign-plugin-docs` uses for its own `(home)/layout.tsx` +
`DocsSidebar`). The detail column only appears once something is selected,
driven by local component state, not a route change.

```
┌──────────┬─────────────────────────┬───────────────┐
│ Sidebar  │  Main                    │  Detail        │
│          │                          │  (conditional, │
│ Trips    │  (per-section content)   │   on select)   │
│ Check-ins│                          │                │
│ Planner  │                          │                │
│          │                          │                │
│ Settings │                          │                │
└──────────┴─────────────────────────┴───────────────┘
```

### Sidebar navigation

Top links: **Trips**, **Check-ins**, **Planner** — mirrors
`sovereign-plugin-docs`'s `DocsSidebar` structure directly (link list, a
divider, then a bottom section pinned via `margin-top: auto`). **Settings**
sits in that bottom section — a configure-once screen, not a browsing one.

### Trips

The browse/manage/share hub — not where the itinerary gets built (that's
Planner).

- **Overview block** at the top: trip counts (planned / completed), unique
  places visited, unique countries/regions visited, total check-ins, and a
  "next trip in N days" highlight when one is upcoming. Deliberately no
  streak-style tile — these are the same kind of read-only aggregate as the
  visit log's counts (see "Check-ins," below), not a reward mechanic.
- **Trip cards**, grouped by status (Planning first) and sorted by date
  within each group: name, date range, day count, a destination summary,
  status badge. Status (`planning` / `upcoming` / `ongoing` / `completed`)
  is **derived from the trip's stops**, not a field set directly — no stops
  yet means `planning`; once dated stops exist, today's date against the
  derived range decides the rest. *(Open question, below: should a trip
  stay `planning` even with dated stops until explicitly finalized? Derived
  status is what phase 1 ships; simpler to build, revisit if it feels
  wrong.)*
- Card CTA depends on status: **Continue planning** (planning) → Planner;
  **View itinerary** (upcoming) → Planner in read mode; **Open Trip Mode**
  (ongoing) → Planner's day view, mobile-only; **View trip** (completed) →
  the detail column.
- **Filtering**: status chips (All/Planning/Upcoming/Ongoing/Completed) + a
  name search. Year filtering is deferred until trip history is actually
  large enough to need it.
- **Clicking a card** (not its CTA) opens the **detail column**: basic trip
  metadata, and sharing — add/remove people via the platform user directory
  (`sdk.directory`, same pattern as `sovereign-plugin-docs`'s
  `FolderShareButton`/`FolderShareDialog`). A shared trip's members can view
  and edit it; only the owner manages membership. **This access model is
  inferred from "add/remove people" + a "settings" panel — not yet
  explicitly confirmed; see open questions.** A full single-page trip
  details view is explicitly deferred (your own scoping call — "for now we
  can skip that by just showing basic trip details"); the detail column
  stays intentionally basic until that page exists.
- **"Create trip" CTA** opens a modal — the same underlying action Planner's
  own "New trip" triggers; there's exactly one create-trip flow with two
  entry points.

### Check-ins

**Viewing** only on web — **creating** a check-in is mobile-only (deferred,
see below). Reverse-chronological **timeline**, grouped by day; a map view
is deferred (tied to the still-open place/map-provider question). Clicking
an item opens the detail column: place, note, photo, trip link (if any)
with an unlink action.

**Swarm import lives here too**, as its own action distinct from live
check-in capture — importing a ZIP is a one-time file upload, which is a
natural web task (awkward on mobile), unlike capturing a single check-in in
the moment. Designed **resumable from the start**: photos in a Swarm export
are URLs, not files, so importing a decade of history means a long-running,
rate-limited, partially-failing fetch job, not a single request/response.
The generic GPX/KML/GeoJSON/CSV importer (the realistic fallback for
Wanderlog, Wanderlust, Google Takeout, Google Maps saved lists, Day One) is
the same web-triggered shape.

*(Open question, below: does the timeline show every check-in with an
inline trip badge, or default-scope to unlinked ones since trip-linked
check-ins are also visible from inside their trip? Leaning "everything,
badge inline" — one unified log is the point of the log spine.)*

All of the above — timeline, counts, aggregates — are **read-side
projections over `visit` rows**, never separately stored state. This is
what makes a decade of imported history produce the exact same counts and
views as if recorded live, and what makes adding read-only "game-adjacent"
views later (should that ever be revisited) a projection change, not a
migration.

### Planner

The itinerary-building workspace — for a trip being created right now, or
one already created from Trips. Both paths converge on the same "create
trip" action.

- **No trip selected**: a picker scoped to Planning + Upcoming trips (an
  already-completed trip's itinerary is edited from Trips instead, not
  here), plus a "New trip" CTA using the same creation modal as Trips.
- **Trip selected**: one workspace screen, not a page-per-stop drill-down —
  a **stop timeline strip** across the top (ordered: starting point, then
  each subsequent location, each with its own arrival/departure dates,
  reorderable, with an "Add a stop" affordance at the end), and below it,
  the **day-by-day itinerary** for whichever stop is currently selected in
  the strip (days generated from that stop's date range; each day lists
  itinerary items — place, planned time, notes — reorderable, addable).
  Selecting a different stop swaps which stop's days show below it, with no
  page navigation.
- Adding or editing a timed itinerary item offers marking it **fixed** vs
  **flexible** (see "Decided," above).
- Clicking a specific itinerary item opens the detail column for its edit
  view (place, time, fixed/flexible, notes) — same click-to-detail pattern
  as Trips and Check-ins, just scoped to one item.
- Terminology note: **"stop"** is the working term (matches how
  Wanderlog/Google Maps describe a multi-city trip) — open to a better word
  if one turns up.
- **Trip Mode's entry point lives here, mobile-only**: tapping "Start" on a
  stop's day view launches Trip Mode using that day's plan, active only
  during the trip's real dates. Phase 1 launches it with the plan exactly
  as manually ordered — see "Future (deferred)," directly below, for what
  happens behind that same button later.

## Future (deferred): trip navigation & route optimization

Not built in phase 1 — "Start" (mobile-only, from a stop's day view in
Planner) enters Trip Mode with the day's plan **exactly as manually
ordered**. What's deferred is making that same button progressively
smarter — no new UI surface needs designing later, current position + next
stop + countdown + native-maps hand-off is all phase 1 builds:

- **Phase 2a — proximity reordering.** Resequence the day's **flexible**
  items by straight-line (haversine) distance from wherever you currently
  are, leaving **fixed** items in place. No routing engine, no external
  provider — everything it needs (coordinates, the fixed/flexible split)
  already exists in the phase 1 data model.
- **Phase 2b — real routing-aware optimization.** Travel-time- and
  road-network-aware sequencing via an actual routing/distance-matrix
  provider — the same category of external-dependency decision as the
  place-search provider (open question 1, below). If that lands on the
  OSM-leaning option, **OSRM** (self-hosted, open-source routing) is a
  natural sibling — same self-hosted posture, no BYO cloud key — not
  committed to, just noted as a fit. Will eventually need a **travel mode**
  (walking/driving/transit) field somewhere on the trip or day; not needed
  for 2a, not designed yet.
- Items with no resolved place/coordinates (title-only itinerary items,
  already schema-legal) simply can't participate in either tier — they stay
  wherever manually placed. Nothing to build for this; the future optimizer
  just has to skip them.

## Data classes at a glance

Product-level description, not a schema — `SPEC.md` formalizes this:

- **Place** — a shared location: name, coordinates, category, and a
  reference back to whatever provider (or manual entry) it came from. Used
  by visits and itinerary items alike, so "I finally went there, twice" is
  one coherent record instead of several disconnected ones.
- **Visit** — a check-in: place, when it happened (with real timezone
  handling — UTC + IANA zone + local offset, not just a naive timestamp),
  optional note/photo(s)/companions, and an optional resolved trip link.
- **Trip** — an ordered sequence of stops; its own date range is derived
  from its stops, never set independently. Optionally shared with specific
  platform users, added/removed from the trip's detail panel (see "Web UI,"
  above — the underlying access model there is inferred from the UI
  description, not yet explicitly confirmed).
- **Stop** — a place plus an arrival/departure date range: the unit a trip
  is built from ("starting point, then locations in between").
- **Trip day / Itinerary item** — each stop's date range breaks into days;
  each day has an ordered list of planned items (place, planned time,
  notes), each markable **fixed** or **flexible**.
- **Attachment** — a receipt, booking confirmation, or accommodation
  record tied to a trip or a specific day.

## Out of scope for phase 1

| Deferred | Why |
| --- | --- |
| Inbound booking-email parsing | No platform inbound-email capability; a large standalone workstream on its own |
| AI itinerary generation | Belongs to the platform's core assistant, not this plugin |
| Route optimization | Explicitly staged, not rejected — see "Future (deferred): trip navigation & route optimization," above, for the two-tier plan and what phase 1 already builds toward it |
| Background auto-check-in | Requires a native shell with background location — post-v1 mobile territory |
| Bill splitting / budgets | Consume from a wallet/splitting plugin via a data contract instead of building it here |
| Real-time collaborative editing | No CRDT/presence primitive on the platform |
| Public journey sharing | Overlaps the platform's public-routes work; defer until the core product works |
| **All reward mechanics** — coins, stickers, badges, streaks, mayorship, leaderboards | Decided out for this phase. Meaningless at single-instance/household scale, and a distraction from the actual product. Addable later with no schema change, if ever revisited. |

## Open questions carried into SPEC.md

Not resolved here, so nothing gets silently dropped. Two items from the
first draft are gone because they got resolved while drafting `SPEC.md`,
not because they were dropped: **location source** is settled as
plugin-local `navigator.geolocation` (`sdk.device.geolocation` doesn't
exist — verified directly against `packages/sdk/src/device.ts`), and
**photo storage volume** turned out to already have a platform answer
(operator-configurable `SOVEREIGN_STORAGE_MAX_OBJECT_BYTES` /
`SOVEREIGN_STORAGE_MAX_PLUGIN_BYTES`, not something this plugin needs to
design). See `SPEC.md`'s "A note on drift" section for the full detail.

1. **Place/map provider.** The research doc leans manual-first architecture
   with OpenStreetMap (Nominatim/Overpass or a Photon instance) as the
   default adapter, and a bring-your-own-API-key (Google Places/Mapbox) as
   an opt-in upgrade — but this isn't locked, and it's the single largest
   technical unknown in the whole plugin. Needs its own technical decision,
   and possibly its own RFC, before Slice 1's check-in UI can really be
   built.
2. **Trip sharing semantics.** The Trips detail panel (see "Web UI," above)
   assumes real shared access — another platform user can view/edit a trip
   they're added to, via `sdk.directory` + a `travellog_trip_members`-style
   table, the same pattern Docs folders and Kanban boards already use — but
   this was inferred from "add/remove people" + a settings panel, not
   explicitly confirmed. The alternative is lightweight companion tags (no
   real access granted, just names for context).
3. **Trip planning-status derivation.** Pure computed status (`planning` ⇄
   `upcoming` ⇄ `ongoing` ⇄ `completed`, driven entirely by stop dates) vs.
   an explicit status the user sets — e.g. a trip stays `planning` even
   with dated stops until the user finalizes it. Phase 1 ships the derived
   version; revisit if it feels wrong once there's real usage.
4. **Check-ins timeline scope.** Every check-in shown with an inline trip
   badge, or default-scoped to unlinked check-ins only (trip-linked ones
   are already visible from inside their trip). Leaning "everything, badge
   inline."
5. **Swarm export field mapping is unverified.** The field list in the
   research doc is inferred from third-party tooling and the public
   Foursquare API shape, not from an actual export file. Verifying it
   against a real export is the highest-value, lowest-cost thing to do
   before the importer's mapping is locked in `SPEC.md`.
6. **Auto-link precision.** Date-window overlap alone will mislink (e.g. a
   work trip and a personal weekend that share dates). Does geography
   participate in the match? Does the user confirm once and have it learn?
7. **Routing/distance-matrix provider.** Only needed for the deferred Phase
   2b route optimization (see "Future," above) — mirrors open question 1,
   not designed, not urgent.
8. **"Stop" terminology.** Working term for a trip's ordered locations —
   open to a better word if one turns up.

## Deferred, not yet planned

Noted here so they aren't mistaken for decisions rather than gaps:

- **Mobile UI**, for every screen — check-in capture, the visit
  timeline/map, trip browsing, Planner, and Trip Mode's actual live-
  navigation screen. This concept-review pass covered web only; mobile gets
  its own pass before `SPEC.md`'s mobile tasks get written in any detail.
- **A full single-page trip details view**, and the richer "planned vs.
  actual" comparison view that depends on it — your own explicit call
  ("I'm still thinking of Trip Details Single Page structure, so for now we
  can skip that"). The Trips detail column stays basic until this is
  designed.

## Related

- Platform research doc:
  `docs/research/0005-trip-planning-and-place-checkin-plugin.md` (in the
  `sovereignfs/sovereignfs` platform repo) — full options analysis,
  rejected alternatives, and platform-gap findings this concept builds on.
- [`SPEC.md`](SPEC.md) — technical design and task breakdown.
- [`ROADMAP.md`](ROADMAP.md) — prioritized build order.
