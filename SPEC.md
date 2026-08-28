# Sovereign Travellog — Phase 1 Technical Spec

> Technical design and task breakdown for the phase 1 concept in
> [CONCEPT.md](CONCEPT.md). Tasks follow the platform epic format
> (`docs/epics/`): one task = one branch = one PR, sequenced unless tagged
> `[parallel]`. Prioritized build order lives in [ROADMAP.md](ROADMAP.md).

## Status

🚧 In progress — `T.1`–`T.16` shipped, manifest at `0.18.0` (`T.5a`, slot
`0.7.0`, is `[parallel]` and hasn't shipped yet — it doesn't block
`T.6`–`T.16`). Slice 1 (web) is feature-complete; Slice 2's data model,
server layer, auto-link engine, Trips screen, and now the whole Planner
(trip picker, stop workspace, day-by-day itinerary editor) all exist.

**`T.16` — Planner: day-by-day itinerary editor (`0.18.0`).**
`docs/adhoc/web-planner.md` screens 2 (the populated day-by-day list) and 5
(the itinerary-item detail column) — the two screens `T.15` deliberately
left unbuilt. `T.15`'s own `PlannerStopStrip` selection state (`activeStopId`)
is the only input; no new navigation.

**Data layer:** one new query, `listWorkspaceDays` (`_lib/queries.ts`),
fetches every day across the *whole trip* — not just the selected stop — in
two queries total (days, then their items with a `LEFT JOIN` on `places` for
place-backed items' name/category), same "small and bounded, fetch it all"
call `listTripCards`/`listWorkspaceStops` already made for this plugin's
other personal, non-paginated lists. This is deliberate, not just convenient:
`T.16`'s own review checklist requires switching the selected stop to swap
the day list "with no stale data flash," and fetching per-stop on every
switch would mean either a loading flash or a stale-until-refetch window.
With everything already in memory, `PlannerWorkspace` filters
`days.filter(d => d.stopId === activeStopId)` client-side — switching stops
is synchronous, zero network round trips, zero flash risk by construction.

**State ownership, mirroring `T.14`'s `TripsScreen`/`TripDetailPanel`
split exactly:** `PlannerWorkspace` now owns `days` (copied into local state,
unlike `stops` which stays a direct prop — see below) and `selectedItemId`;
`PlannerItemDetailPanel`'s field edits bubble a `patch` up via `onChange`
rather than calling `router.refresh()`, keeping the day list and the open
detail panel in sync from one state update, the same pattern
`TripDetailPanel`'s companions field already established for its own
list+detail split (`MainDetailSplit`, reused here — its own doc comment
already named `T.16`'s item detail as a planned second consumer, alongside
`T.14`'s trip detail). `days` *is* copied into local state (`stops` isn't)
because `_lib/itinerary-items.ts`'s own header comment says mutating an item
never touches anything else on the page — no denormalized trip dates to
resync, unlike a stop mutation, so there's nothing a `router.refresh()`
would need to catch that local state doesn't already have.

**New components:** `PlannerDayList` (day headings + item rows, one
`DndContext` **per day** rather than one shared across the list — scopes
dnd-kit's collision detection so a drag can never land in a different day,
satisfying "reorder within a day writes exactly one row per drop" by
construction rather than a runtime check) and `PlannerItemDetailPanel`
(screen 5: place read-only summary, planned time, the Fixed toggle, notes,
remove). `AddItineraryItemDialog` reuses the exact place-search flow
`AddStopDialog` established in `T.15` (same `searchPlacesAction`/
`createPlaceAction`/`SuggestionInput` pattern), but adds a second path that
dialog didn't need: `SuggestionInput`'s existing `onCreate`/`createLabel`
affordance is repurposed so "add without a place" commits a **title-only**
item (`placeId: null`) rather than creating a manual place record — matching
`itinerary-items.ts`'s schema comment that a title-only item is legal, and
avoiding a spurious `places` row for something like "Free time" that was
never a real place. No dedicated wireframe screen for this dialog exists
(`web-planner.md`'s Phasing section only wireframed screens 2/5 for `T.16`)
— it's an original small dialog built by extending the established
place-search pattern, not by inventing new UI language.

**Real bug caught and fixed before it shipped: fixed-but-untimed is a real
reachable state, not just a schema edge case.** `itinerary-items.ts`'s
`updateItineraryItem` validates the *merged* result (existing row + patch),
so clearing `plannedTime` on an already-`isFixed` item throws server-side
("Only a timed item can be marked fixed") — reachable the moment a user
clears the Planned time field on a fixed item, not a contrived case.
`PlannerItemDetailPanel`'s `commitPlannedTime` now detects this in the same
patch (`next === null && item.isFixed` → also send `isFixed: false`) so
clearing the time silently un-fixes the item instead of surfacing a
confusing error for an action the user didn't take directly. Caught by
reasoning through the merge-validation logic while writing the detail panel,
confirmed live (see below) before considering the task done.

**Live verification, including the two tooling caveats already documented in
`T.15`'s own status entry (both held again here):** `SuggestionInput`'s
popover only opens on a real `focus` event (`focused` state, not just a
`value` change) — a synthetic `input` event alone leaves it closed even
though the debounced fetch still resolves; dispatching `.focus()` first
fixed it. dnd-kit's keyboard sensor needed real `KeyboardEvent`s dispatched
via `javascript_exec` (`code: 'Space'`/`'ArrowDown'`, not the `computer`
tool's key action, which never registered a pickup per dnd-kit's own
`DndLiveRegion` announcements staying empty) — once switched, pickup →
move → drop worked and was confirmed to persist across a full page reload,
not just optimistically in the DOM. Verified end-to-end: add a place-backed
activity (search → select → detail column opens automatically) and a
title-only one (search → "Add … without a place"); set a planned time,
confirm the Fixed toggle enables only after that commits (not on every
keystroke) and a "Fixed" badge appears on the row immediately, no refresh;
drag-reorder two items within a day via the keyboard sensor, confirmed
persisted after reload; clear the time on a fixed item, confirm it silently
un-fixes (the bug above); remove an item via the confirm dialog. A stray
console pass in the same browser tab surfaced a hydration-mismatch warning
and a `loading.module.css` module-not-found error; both were confirmed stale
— a completely fresh tab against the same URL showed zero console errors —
consistent with this session's own documented finding that
`read_console_messages` can return stale/buffered entries across reloads,
not a real regression from this task's changes.

**Design System Gap Check: no gap.** `Toggle`, `Badge`, `Input`
(`type="time"` — a native attribute passthrough, not a new component),
`Textarea`, `OverlayHeader`, `ConfirmDialog`, `FormField` all already exist
and were used as-is; `MainDetailSplit` (plugin-local, not DS, per its own
doc comment) was extended to a third consumer exactly as already planned.

**`T.15` — Planner: trip picker & stop workspace (`0.17.0`).**
`docs/adhoc/web-planner.md` screens 1 (picker), 3 (no-stops-yet workspace),
and 4 (add-stop dialog) — screens 2 and 5 (the populated day-by-day list and
itinerary-item detail) are `T.16`'s job, deliberately not built here.

**New DS component, not a plugin-local one-off:** `StepStrip`
(`packages/ui/src/components/StepStrip`). The wireframe's own engineering
note flagged the stop timeline strip (a horizontal connected-chip row) as a
possible design-system gap and said to "raise it as a design system
proposal" rather than build it plugin-locally — checked
`packages/ui/src/components/` first per DS-first, confirmed nothing fit,
and built it in `packages/ui` instead of here. Deliberately presentational
only: `items`/`activeId`/an optional trailing `onAdd` chip, plus a
`renderItem(item, {isActive}) => ReactNode` render prop that owns each
chip's content, click handling, and (if the consumer needs it) drag-reorder
wiring — the same "DS owns chrome, consumer wires dnd-kit via passed-through
props" split `DragHandleRow` already established for vertical lists,
generalized here for a horizontal, handle-less strip where the whole
rendered item, not a separate handle icon, is both the click target and the
drag surface. Story (`packages/ui/src/stories/StepStrip.stories.tsx`,
default + no-add-affordance variants) and a `DesignSystemOverview.stories.tsx`
gallery entry added per Storybook hygiene; `pnpm --filter @sovereignfs/ui
typecheck` and a full `build-storybook` both clean. `@sovereignfs/ui` bumped
`0.72.0` → `0.73.0` (minor, purely additive) — **this and the component
itself are platform-repo (`packages/ui`) changes, left uncommitted in that
repo**, consistent with this session's established scope: only the
travellog plugin repo gets committed/pushed here, not the platform monorepo.

**A real, deliberate deviation from the wireframe, made before writing any
code, not discovered by a bug:** the wireframe's screen 4 (add-stop dialog)
shows both dates as optional ("leave dates blank for now"). `T.10`'s already-
shipped schema has `travellog_stops.arrive_date`/`depart_date` as `NOT
NULL`, and `_lib/stops.ts`'s `recomputeTripDatesAndAutoLinks` (`T.11`) and
`resolveTripStatus`'s own documented invariant ("`startDate` — null iff
`hasStops` is false," `T.11`) are built on "a stop with dates always has a
real, complete range." Retrofitting nullable stop dates would mean
revisiting three already-shipped tasks' data model and logic for a UI
nicety — out of proportion for what this task needs. `AddStopDialog` makes
both dates required fields instead, with `Depart`'s `DatePicker` given
`minDate={arrive}` so an invalid range can't be picked in the first place,
plus the same inline `compareDateKeys` check `_lib/stops.ts`'s `createStop`
already does server-side, so the wireframe's own stated "Error (expected):
depart before arrive" case still surfaces before a round trip.

Built: `_lib/queries.ts`'s `listTripsForPicker` (payload 6 — lighter than
`listTripCards`, no destination-summary/day-count joins the picker never
renders) and `listWorkspaceStops` (payload 7's stop list, place-enriched);
`PlannerPicker.tsx` (the picker screen, reusing `CreateTripDialog`
unmodified — it already navigates into the new trip's Planner page on
success); `AddStopDialog.tsx` (place search is the exact same
`searchPlacesAction`/`SuggestionInput` flow as check-in's, `T.3`/`T.7`, just
scoped down — no GPS "check in here" path, since planning a stop isn't tied
to the planner's own physical location); `PlannerStopStrip.tsx` (wires
`StepStrip` to real drag-reorder: `dnd-kit`, `PointerSensor` at a 6px
activation distance, no handle — the same pattern as `sovereign-plugin-kanban`'s
`CardTile` drag, matching CLAUDE.md's own "Ordering... match
sovereign-plugin-kanban's approach" convention); `PlannerWorkspace.tsx`
(owns `activeStopId` and the one `AddStopDialog` instance both the
empty-state prompt and the strip's trailing chip open — one add-a-stop flow
regardless of entry point); `app/(home)/planner/page.tsx` and
`.../planner/[tripId]/page.tsx` replace their `T.13`-era placeholders.

**A real hydration bug, found live via the dev error overlay, not by any
check:** `PlannerStopStrip`'s `DndContext` had no explicit `id`. Without
one, `dnd-kit`'s internal `aria-describedby` id comes from a global
mount-order counter — SSR (always starting fresh at 0 for its own isolated
render) and the client (already incremented by any other `DndContext`
mounted earlier in the page's lifetime, e.g. across HMR remounts in dev)
can disagree on that counter, producing a real, if cosmetic, "hydrated but
some attributes... didn't match" mismatch. `sovereign-plugin-kanban`'s own
`DndContext` already carries an explicit `id="kanban-board-dnd"` for
exactly this reason — matched here with `id="planner-stop-strip-dnd"`.
Confirmed fixed by direct DOM inspection (`aria-describedby` reads the
stable custom id, matching across every chip) rather than trusting the
console log, which turned out to have its own quirk — see below.

**Live-verification technique notes, both real findings about the tooling
in this environment, not the app:**

- **The Browser pane's `computer` tool's coordinate/ref-based clicks were
  confirmed unreliable for several interactions this task** (a picker row's
  "Open →" link, a place-search suggestion's `onMouseDown` row, a
  `DatePicker` calendar cell) — `document.elementFromPoint`/`activeElement`
  checks confirmed the click was landing on the *correct* element but not
  always registering. Diagnosed before assuming any of it was a product
  bug, and worked around throughout via `javascript_exec`-dispatched real
  events (`element.click()` for buttons; the native `HTMLInputElement`
  value setter + a dispatched `input` event, focus-checked, for controlled
  text fields) — the same "script it instead" fallback
  `sovereign-plugin-kanban`'s own CLAUDE.md already documents for
  drag-specific verification, found here to generalize to plain clicks too
  in this session's environment.
- **The console-message tool returns stale/buffered entries that don't
  reflect the current DOM state**, confirmed twice: a `Module not found:
  ./loading.module.css` error kept reappearing across hard reloads long
  after `read_network_requests` proved the same CSS chunk resolving `200
  OK` on the most recent request; the `DndContext` hydration mismatch above
  kept reappearing (still showing the pre-fix `DndDescribedBy-N` value)
  after the fix had already landed and a direct DOM check confirmed the
  stable id was live. Both resolved by trusting direct, current-state
  checks (network responses, live DOM attributes) over the console buffer
  once the discrepancy was noticed — a real quirk of this session's tooling
  worth remembering, not a reason to distrust every console error going
  forward.
- **Drag-and-drop needed real `PointerEvent`s dispatched on the exact drag
  target, not `document`/`window`:** `dnd-kit`'s `AbstractPointerSensor`
  attaches its `move`/`end` listeners directly on `event.target` from the
  originating `pointerdown` (confirmed by reading the installed
  `@dnd-kit/core` source, `getEventListenerTarget`) — dispatching the
  follow-up `pointermove`/`pointerup` on `document.dispatchEvent(...)`
  looked plausible (bubble listeners usually don't care where you dispatch
  from) but silently did nothing, since a document-dispatched event never
  propagates *down* to a descendant's own directly-attached listener.
  Dispatching every event in the sequence on the chip itself fixed
  activation (confirmed live: `isDragging` true, correct
  `translate3d(...)` tracking real-time pointer position) but the
  pointer-based *drop* still didn't resolve a reorder in this session —
  most likely a collision-detection rect-measurement timing issue specific
  to a fully-synchronous synthetic sequence (dnd-kit's own multi-container
  examples document real timing subtleties here, and `sovereign-plugin-kanban`'s
  K.7 hit a related collision-detection bug), not chased further. The
  **keyboard sensor** (already wired, `KeyboardSensor` +
  `sortableKeyboardCoordinates`) exercises the identical `handleDragEnd` →
  `reorderStopAction` code path and was verified end-to-end instead: focus
  a chip, `Space` (lift) → `ArrowLeft` (move) → `Space` (drop) correctly
  reordered two real stops, persisted through a full hard reload, and
  correctly triggered the trip's denormalized date recompute (`_lib/stops.ts`'s
  `recomputeTripDatesAndAutoLinks` runs on every stop mutation including
  reorder) — the header's date range visibly updated to match the new
  first/last-by-position stop, exactly the scenario `onReordered`'s
  `router.refresh()` callback exists to catch. Pointer-drag *activation*
  is independently confirmed working live; full pointer-drop-to-persist
  was not, and that gap is recorded here rather than silently claimed.

**Live-verified end to end:** the picker (empty and populated, "Open →"
navigating into the workspace); the empty-stops workspace (screen 3's exact
copy); the full add-stop flow (real OSM search results for "Belém," a real
`existingPlaceId`-less candidate resolved through `createPlaceAction`, both
dates required with `minDate` correctly disabling pre-arrival depart dates,
submission, the new stop auto-selected and driving the T.16 placeholder's
per-stop copy); the populated strip (two stops, solid connector between
real stops, dashed connector to the trailing add chip, correct
`day-count`/date-range per chip); keyboard drag-reorder (above). Fresh-tab
console checked clean throughout (net of the stale-buffer entries
explained above, confirmed via direct state checks). Two scratch-DB-seeded
fixtures (a second trip's stop, used only to get two real stops on screen
for the reorder test) were deleted afterward; the real "Belém" stop created
through the actual `AddStopDialog` flow was left in place, matching the
established "leave UI-created data, remove only scratch-seeded data"
convention from `T.13`/`T.14`.

Full check suite clean: `format:check`, `lint`, this package's `typecheck`,
`design:tokens:check`, and all 286 travellog tests (279 existing + 7 new:
4 for `listTripsForPicker`, 3 for `listWorkspaceStops`) pass; `@sovereignfs/ui`'s
own typecheck and full 522-test suite (84 files) also pass, and
`build-storybook` completes cleanly.

**`T.14` — Trips screen: trip detail panel & sharing (`0.16.0`).** The
click-to-detail column from `docs/adhoc/web-trips.md` screen 3 — status,
dates/stops/days meta, an editable companions field, and an "Open in
Planner" link. Screen 5 (the real member-sharing dialog) was never built:
`schema.ts`'s own header comment records that `T.10` shipped with
`travellog_trip_members` unbuilt (`CONCEPT.md`'s open question 2 was still
unresolved at the time, and the task's conditional scope says to substitute
a plain field in that case) — this task is what actually consumes that
fallback. Confirmed against three independent sources before writing any
code (`SPEC.md`'s own task text, the wireframe's "Open questions" section,
and `schema.ts`'s comment) that this is a real, already-decided fork, not
an open call this task needed to make itself.

Built: `TripDetailPanel.tsx` + `.module.css` (new); `TripCard.tsx` extended
with `selected`/`onSelect` props and click handling; `TripsScreen.tsx`
wired to `MainDetailSplit` (the plugin-local list+detail component `T.6`
built specifically anticipating this reuse) with `selectedTripId` state; a
new `app/(home)/trips/page.module.css` splitting the page into a fixed
`PageHeader` and an independently-scrolling body, mirroring
`checkins/page.module.css`'s established technique exactly, so the detail
column gets real column real estate instead of scrolling the page title
along with it; `_lib/queries.ts`'s `TripCard`/`listTripCards` extended with
a `companions: string[]` field, parsed from the same `trips` row this query
already fetches — no second round trip for the detail column's own data,
same "don't add a fetch for data already in hand" call `T.13` made for its
card grid.

**No new server action.** `updateTripAction(tripId, patch)` already existed
from `T.11` and already accepted a `companions` patch — `actions.ts`'s own
header comment on the Trips section states outright that `trips.companions`
is "edited through `updateTripAction` like any other." This task's only
server-layer change is the `listTripCards` field addition above; the
mutation path needed nothing new.

**Three real design decisions, not just wiring:**

- **The companions field is genuinely editable** (`TagInput`, committing on
  Enter/comma and via `TagInput`'s own built-in blur-commit), not the
  read-only display the wireframe's literal wording ("a plain,
  non-interactive text field") first suggested. Resolved in favor of
  editable by weighing the wireframe's phrasing against two more concrete,
  more authoritative signals pointing the other way: SPEC.md's own T.14
  deliverable text calls it "a plain free-text field... no access-control
  implications" (a form field, not a label), and `actions.ts`'s existing
  comment already asserts it *is* edited through `updateTripAction`. An
  editable field with no edit surface anywhere in the product would leave
  `updateTripAction`'s `companions` patch permanently unreachable from the
  UI — the wireframe's "non-interactive" almost certainly meant "not backed
  by `sdk.directory`/access control," not "read-only," a needed
  clarification.
- **The Completed card's CTA ("View trip") changes from `disabled` to a
  real action** — opening this same detail column, not routing to
  Planner like every other status. `T.13`'s own code comment on that button
  read "Coming in T.14," but this task's actual deliverables never
  mention a full trip page (the wireframe defers that separately, and it
  has no task slot yet) — so "the destination `T.14` was waiting to build"
  turned out to be the detail column, not a page. Re-using Planner for a
  completed trip's CTA would have been the easy default but a worse fit:
  Planner is a stop-*editing* workspace ("Continue planning"/"View
  itinerary" fit the in-progress statuses); the detail column's read-mostly
  meta view is the closer match for "look at a trip that's already over."
- **Optimistic local update with rollback on `updateTripAction` failure**,
  not a refetch-after-save. `TripsScreen`'s `cards` state updates
  immediately when a companion is added/removed (so the `TripCard` grid and
  a later re-open both stay in sync without a second query), and
  `TripDetailPanel` reverts to the pre-edit value via the same setter if
  the server call comes back `{ ok: false }` — surfaced with a toast,
  matching `CheckinDetailPanel`'s existing Unlink error-handling shape
  exactly (`sv-ui-design`'s "expected failures never throw, render inline"
  convention, extended to a toast since this field has no dedicated error
  slot of its own).

**Live-verified end to end, including a real automation-tooling gotcha
worth recording so it isn't re-diagnosed as a code bug next time:** raw
pixel-coordinate clicks in the Browser pane tool intermittently landed on
the right element by accessibility-tree inspection (`document.elementFromPoint`
confirmed the click target was the correct `div[role="button"]`, nested
correctly under `.cardGrid`/`.screen`) but did not always trigger React's
click handling, while `ref`-targeted clicks and a directly-dispatched
`element.click()` both worked reliably. Diagnosed by comparing
`elementFromPoint` output against the expected DOM chain before touching
any component code — ruled out a selection/`stopPropagation` bug in
`TripCard.tsx` before it was ever suspected. Verified with that reliable
click path: clicking a card's body opens the detail column with the
correct trip's data and a solid selected border; the same click again (or
the panel's own close button) closes it; the "Continue planning" CTA still
navigates straight to Planner without also opening the detail column
(`stopPropagation` confirmed); adding "Sam" via the companions `TagInput`
committed on blur (Enter didn't reliably commit through the automation
tool, but `TagInput`'s own blur-commit — the exact mechanism
`useCommitOnEnterOrBlur`-style inputs exist for — covered it), persisted
through a full page reload, and round-tripped correctly through
`updateTripAction` into the database; a seeded `completed`-status trip's
"View trip" CTA opened the same detail column instead of staying disabled.
Fresh-tab console checked clean throughout. The seeded completed trip was
deleted afterward; the real "Sam" companion added through the actual UI
flow was left in place, matching how `T.13`'s own UI-created "Kyoto &
Osaka" trip was left rather than scrubbed.

Full check suite clean: `format:check`, `lint`, this package's `typecheck`,
`design:tokens:check`, and all 279 travellog tests (278 existing + 1 new,
covering `listTripCards` carrying `companions` on the card payload) pass.

**`T.13` — Trips screen (web): overview & cards (`0.15.0`).** The
browse/manage hub from `docs/adhoc/web-trips.md` screens 1, 2, and 4 — an
overview strip (trip counts by status, unique places/countries, total
check-ins, next-trip countdown), trip cards grouped by computed status
(Planning first) and sorted within each group, status-chip + name-search
filtering, and a "Create trip" modal. Card-click-to-detail and trip sharing
are `T.14`'s job, deliberately not built here — confirmed against
`SPEC.md`'s own task list, `CONCEPT.md`'s Trips section, and the wireframe
doc's own "Phasing" note before starting, so no dead detail-column
affordance got built early.

Built: `_lib/dates.ts` extended with `daysBetweenDateKeys` and
`formatDateRange` (both following the same UTC-noon-anchored,
DST-immune arithmetic `T.11` established); `_lib/queries.ts`'s
`getTripsOverview` (tallies every trip's `resolveTripStatus` from `T.11`
into per-status counts, aggregates unique places/countries/check-ins across
`visits`/`places` in one query, and picks the soonest `upcoming` trip for
the next-trip highlight) and `listTripCards` (one unpaginated fetch — a
personal trip list is small and bounded, unlike check-in history, so all
filtering happens client-side over a single payload); `TripCard.tsx` +
`TripsScreen.tsx` (the filtering/grouping client component) +
`CreateTripDialog.tsx`; and a new `app/(home)/planner/[tripId]/page.tsx`
placeholder so "create a trip and land in Planner for it" has a real,
non-404 destination ahead of `T.15` — the same "build the hook point now,
wire the real thing later" precedent as `T.6`'s Unlink button.

**Two DS-first component choices reversed after checking against the
wireframe's own stated constraints, not just picked at a glance:**

- `SegmentedControl` was the obvious first reach for the status filter
  chips, but its own doc comment describes a "pill-based 2–3 option picker"
  with a connected visual track — the wireframe shows four separate,
  individually-outlined pill chips, a materially different visual. Built as
  plain plugin-local `<button role="radio">` elements instead, matching this
  repo's existing precedent (`CheckinsTimeline.tsx`'s row/badge treatment)
  for narrow patterns that don't match an existing DS component.
- `Badge variant="status"` was used for the Ongoing card's status badge in
  an early draft, then reverted after re-reading the wireframe doc's
  explicit constraint: "No color-coded status badges... status is
  distinguished by badge text and the Ongoing card's filled-vs-outline CTA
  treatment" — `variant="status"` renders a colored dot per status,
  directly contradicting that. Switched to plain `Badge variant="mono"` for
  all four statuses, with the CTA button's `primary`/`ghost` variant
  carrying the Ongoing distinction instead, exactly as the wireframe
  specifies.

**One real ESLint catch, not just a style nit:** `CreateTripDialog.tsx`'s
`Input` initially had `autoFocus`, flagged by `jsx-a11y/no-autofocus`.
Removed rather than disabled — `Dialog` already handles focus management,
so it was redundant as well as a real accessibility smell.

Data-layer tests (`dates.test.ts`, `queries.test.ts`) surfaced two small,
quickly-fixed issues, no logic bugs in the new query functions themselves: a
missing `eq` import in a new `queries.test.ts` test, and one test's own
wrong expected `dayCount` (`5` instead of `6`) for two overlapping 3-day
stops sharing a handover date — corrected once traced through the schema
(`trip_days` rows are unique per `(stop_id, date)`, not `(trip_id, date)`,
so the shared date legitimately produces two rows, one per stop).

**Live-verified end to end**, including states no existing seed data
covers: since Planner (`T.15`) doesn't exist yet to create stops through
the UI, three additional trips — one each in `upcoming`/`ongoing`/
`completed` status — were seeded directly into the dev database (the same
technique `T.9`/`T.12` used), confirming all four status groups, the
overview tallies, the next-trip countdown, the "day 3 of 5"-style ongoing
meta line, and exact date-range formatting all rendered correctly on the
first attempt. Also verified: the empty state plus its "Create trip" flow
(including the dialog's pending/loading label), each status filter chip in
isolation, name search narrowing to a single match, and the "No trips match
your filters." empty-filter state for a deliberately-non-matching query.
Fresh-tab console checked clean throughout. The three seeded trips were
deleted from the dev database afterward, leaving only the one trip created
through the real Create Trip flow during this same verification pass.

Full check suite clean: `format:check`, `lint`, this package's `typecheck`,
`design:tokens:check`, and all 278 travellog tests (264 existing + 14 new:
4 in `dates.test.ts` for `formatDateRange`, 10 across two new
`describe` blocks in `queries.test.ts` for `getTripsOverview`/
`listTripCards`) pass.

**`T.12` — Auto-link engine (`0.14.0`).** The date-window auto-link from
SPEC.md's Data model section, running on both new check-ins and existing
history, plus a manual override.

Built: `_lib/auto-link.ts` (`pickBestTrip` — pure, the narrower-range-wins
selection; `computeAutoLinkForVisit`; `recomputeAutoLinksForActor`);
integration into `_lib/visits.ts`'s `createVisit` (inside its own
transaction, so both `T.4`'s manual/GPS action and `T.8`'s Swarm importer
get it for free — one write path, one auto-link call site); integration
into all four of `_lib/stops.ts`'s mutations via a new
`recomputeTripDatesAndAutoLinks` (replacing the old `recomputeTripDates`);
`_lib/visits.ts`'s `setVisitTripLink`; `actions.ts`'s
`setVisitTripLinkAction`/`recomputeMyAutoLinksAction`; and — genuinely new
UI, not just server plumbing — the previously-`disabled` "Unlink" button in
`CheckinDetailPanel.tsx` (built by `T.6`/`T.9` specifically so `T.12` "only
has to wire the action") now actually works.

**A real bug, caught by the tests written to prove the algorithm correct,
not found live:** `pickBestTrip`'s range-membership filter had its second
boundary comparison sign flipped
(`compareDateKeys(visitDateKey, trip.endDate) >= 0` instead of `<= 0`) —
every trip whose end date was *on or after* the visit's date matched
(correct), but so did every trip whose end date was *before* it (wrong),
while a trip a visit's date fell width-inside of but exactly-on-the-end-
date-boundary of failed to match at all. 9 of the first 16 tests written
against the pure `pickBestTrip` function failed immediately, including the
most basic "returns null when no trip's range contains the date" case —
caught before this ever touched a database, let alone a live check-in.
Fixed by correcting the comparison direction; all 16 (now 17) tests passed
on the next run with no other changes needed.

**Two real design decisions made, not just implementation details — both
because building the feature surfaced a genuine gap in `T.10`'s original
schema comment, not because the spec dictated them:**

- **Recompute is actor-wide, not trip-scoped**, even though it's triggered
  by one specific trip's stops changing. A single trip's date-range edit
  can change which trip is "narrower" for a visit currently linked to a
  *different* trip (the whole reason "narrower wins" exists — two trips can
  overlap), so scoping the recompute to just the changed trip would miss
  real reshuffles. Verified directly: a test creates two trips, links a
  visit to the wider one, then creates a narrower trip covering the same
  date — recompute correctly leaves the manually-linked visit alone (manual
  always wins) but a separate test confirms an *auto*-linked visit would
  have moved to the narrower trip had it not been manual.
- **`{tripId: null, linkSource: 'manual'}` is now a valid, meaningful,
  *sticky* state — correcting `T.10`'s original schema comment**, which
  read "linkSource null iff tripId null" as a strict invariant. Building
  the actual Unlink button surfaced why that was wrong: if unlinking simply
  cleared both columns to null, the visit would become eligible for
  auto-relink again, and a later stop edit could silently reattach a trip
  the user explicitly said "no" to — a real, surprising UX regression
  nobody asked for. `setVisitTripLink` now always writes
  `linkSource: 'manual'` for *both* linking and unlinking (`tripId` a real
  id or `null`), and `recomputeAutoLinksForActor` already skips every
  `'manual'` row regardless of its `tripId` (it filters on `linkSource`,
  never `tripId`), so this required zero changes to the recompute query
  itself — only the schema comment and `setVisitTripLink`'s own behavior.
  `schema.ts`'s `linkSource`/`tripId` comments rewritten to state the
  corrected invariant precisely, including the one deliberate exception
  that still nulls both together: `deleteTrip` (`T.11`), where the whole
  trip an override pointed at disappearing resets the visit to fully
  undecided, not to "manually excluded from everything."

**Live-verified, not just unit-tested** — the first genuinely new,
UI-observable behavior since `T.9`, so it went through the browser, not
just `vitest`: seeded a trip/stop/auto-linked visit directly in the dev
database (no Trips/Planner UI exists yet to create one through), reloaded
Check-ins, confirmed the timeline row's "Trip" badge and the detail
column's "Part of a trip" + "Unlink" button both rendered for a real check-
in for the first time, clicked Unlink, and confirmed three things at once:
the detail panel's trip section disappeared (a real re-fetch, not a stale
view), the timeline row's badge cleared too (the local `items` state
update, not just the detail panel), and the underlying database row ended
up exactly `{tripId: null, linkSource: 'manual'}` — queried directly, not
inferred from the UI alone. Fresh-tab console checked clean throughout.

Full check suite clean: `format:check`, `lint`, this package's `typecheck`,
`design:tokens:check`, and all 264 travellog tests (240 existing + 24 new:
17 in `auto-link.test.ts`, 7 extending `actions.test.ts` — a manual link
surviving a recompute, denying a link to another user's trip, and the
`createVisitAction` integration test confirming both the match and
no-match paths) pass.

**`T.11` — Trip, stop & itinerary server layer & actions (`0.13.0`).** CRUD
and reorder for trips, stops, days, and itinerary items, the derived status
resolver, attachment upload/delete, all wired into `actions.ts` with
per-resource authorization — no UI consumes any of it yet (`T.13` onward).

Built: `_lib/dates.ts` (pure `YYYY-MM-DD` calendar-date arithmetic, UTC-noon
anchored so it's provably immune to the host process's own timezone — see
below); `_lib/trip-status.ts`'s `resolveTripStatus()`; `_lib/trips.ts` (trip
CRUD, including a `deleteTrip()` that explicitly clears the blocking rows
`T.10`'s `restrict` FKs would otherwise reject a plain `DELETE` for);
`_lib/stops.ts` (the largest module — stop CRUD/reorder, each recomputing
the trip's denormalized dates and syncing `trip_day` rows to match);
`_lib/itinerary-items.ts` (CRUD/reorder, the `isFixed`/`plannedTime`
coupling); `_lib/attachments.ts` extended with real `createAttachment`/
`deleteAttachment`; a new Route Handler,
`app/(home)/trips/attachments/upload/route.ts`; five new
`requireXOwner()` authz helpers (`_lib/authz.ts`); and ~20 new actions in
`actions.ts`.

**`_lib/dates.ts` is deliberately its own module, separate from
`_lib/timezone.ts`.** `timezone.ts` converts a UTC *instant* into a zone's
local date/time; nothing in `dates.ts` touches an instant or a timezone at
all — a stop has no single timezone of its own in phase 1, so "arrives
September 1st" is bare calendar-date arithmetic, anchored at UTC noon
specifically so incrementing by exactly one UTC day can never cross a local
DST boundary (there is no local zone in the calculation to cross one in).
`T.11`'s own review checklist calls out DST explicitly — verified, not just
argued: one test spans the exact two 2026 US DST transition dates
(2026-03-08, 2026-11-01) confirming no day is skipped or duplicated, and
another runs the identical calculation under two opposite-extreme stubbed
`TZ` values (`Pacific/Kiritimati`, UTC+14, vs `Etc/GMT+12`, UTC-12) and
asserts byte-identical output — proof the host process's own timezone
cannot influence the result, not just an assumption that UTC-anchoring
makes it so.

**The stop-mutation transaction is the most involved code in this task,
and every one of its trickier claims is backed by a passing test, not just
a code comment:** `createStop()` producing 5 `trip_day` rows for a
Monday-to-Friday stop (SPEC.md's own example, verified exactly);
`updateStop()` blocking a date-range shrink that would drop a day with
existing itinerary items — `TripDayHasItemsError`, checked *before* any
write, so a blocked update leaves every row untouched, not partially
applied; a second stop extending the trip's `endDate` while the first
stop's `arriveDate` still anchors `startDate` (first-stop/last-stop-by-
position, not just "any stop"); `reorderStop()` recomputing trip dates too,
since reordering can change which stop is first/last by position.

**Trip deletion required working out how two independent `restrict` FKs
compose (`T.10`'s own design), not just calling `DELETE`.** `T.10`'s
schema entry already reasoned through why `itinerary_items` has *two*
`restrict` FKs (`tripDayId` and the denormalized `tripId`); `deleteTrip()`
is where that reasoning gets used: null every linked visit's `linkSource`
first (the trip's own FK only nulls `tripId`, never `linkSource` — `T.10`'s
documented gap), delete every itinerary item by the trip's denormalized
`tripId` directly, *then* delete the trip — at that point nothing blocks
the `trips → stops → trip_days` cascade. Verified against a full
trip → stop → day → item → linked-visit fixture, not just an empty trip.

**No separate "trip sharing" actions** — `T.10`'s own decision (CONCEPT.md's
open question 2 still unresolved) means `travellog_trip_members` was never
built; `trips.companions` is just another field on `updateTripAction`'s
patch, same as `name`/`timezone`. `T.11`'s spec deliverable list already
phrased this bullet as conditional ("if `travellog_trip_members` exists"),
so nothing needed correcting there.

**Attachment upload follows the same Route-Handler precedent as `T.7`/`T.8`,
for the same reason** (a receipt or booking PDF routinely exceeds Next's
1 MB server-action body cap) **— with ownership checked twice, deliberately,
not redundantly.** The upload route checks the caller owns the target
(`tripId` or `tripDayId`) before ever writing bytes to `sdk.storage`;
`createAttachmentAction` checks it again independently before writing the
DB row, since a client-supplied id reaching a second endpoint is never
trusted twice on the strength of the first check alone. `deleteAttachmentAction`
deletes the DB row first, then calls `sdk.storage.delete()` with the
row's own `storageKey` — verified live against the mocked SDK that a
non-owner's delete attempt never reaches `sdk.storage.delete()` at all,
not just that the row survives.

Full check suite clean: `format:check`, `lint`, this package's `typecheck`,
`design:tokens:check`, and all 240 travellog tests (154 existing + 86 new:
15 in `dates.test.ts`, 7 in `trip-status.test.ts`, 6 in `trips.test.ts`, 15
in `stops.test.ts`, 13 in `itinerary-items.test.ts`, 4 extending
`attachments.test.ts`, 8 in the new upload route's own test file, and 18
extending `actions.test.ts` with the established "authz-denial-without-
side-effects, then happy-path" pattern per action group) pass.

**`T.10` — Trip/stop/itinerary data model & migrations (`0.12.0`).** Schema
and migrations only — `travellog_trips`/`stops`/`trip_days`/
`itinerary_items`/`attachments`, plus activating `visits.trip_id`'s FK
(the column has existed, inert, since `T.2`). No server layer or UI yet
(`T.11`/`T.13`+); this task's only job was getting the data model and its
constraints right, since `T.11`'s CRUD builds directly on top of them.

**Real decision made, not deferred: `travellog_trip_members` was not
built.** SPEC.md's own Data model section flagged that table "⚠ ASSUMED"
pending CONCEPT.md's open question 2 (real shared trip access vs.
lightweight companion tags) — re-checked against the live `CONCEPT.md`
before writing a line of schema, and it's still listed as unresolved.
Per `T.10`'s own conditional scope, substituted a plain nullable
`companions` column on `travellog_trips` instead — same JSON-encoded
`string[]`-of-names shape as `visits.companions`, purely informational, no
access-control implications. `T.14`'s spec already has both UI branches
written out, so nothing there needed updating. If open question 2 later
resolves toward real shared access, this is the column to replace with a
real `travellog_trip_members` table + migration.

**The itinerary-items FK design is the one deliberate exception to "deletes
cascade" in this schema, and getting it right took working through how two
independent FK paths compose, not just picking `restrict` and hoping.**
SPEC.md's Data model notes are explicit that removing a trip day, a stop, or
a trip that still has itinerary items underneath it must be blocked and the
user prompted — "unlike every other cascade-delete in this schema." Both of
`itinerary_items`' parent FKs (`trip_day_id` **and** the denormalized
`trip_id`) are `onDelete: 'restrict'`, deliberately not just one:

- `trip_day_id: 'restrict'` is the direct backstop for "remove a single day
  that still has items" (`T.11`'s stop-date-shrink workflow).
- `trip_id: 'restrict'` (the denormalized column) is what makes a *whole
  trip* deletion fail cleanly and immediately when itinerary items exist
  anywhere underneath it — without it, deleting a trip would rely on the
  `trips → stops → trip_days` cascade chain reaching the populated day and
  failing there instead, which technically also blocks the delete but is a
  murkier, less direct failure to reason about (and not something I wanted
  to depend on SQLite's unspecified cascade-ordering-across-independent-FK-
  paths to get right, rather than verify).
- `stops`/`trip_days`/`trips` themselves stay plain `cascade` — they compose
  correctly with the two restricts above for free: deleting a stop whose day
  still has items fails too, because the `stops → trip_days` cascade
  attempt hits the day's own `restrict` from `itinerary_items` partway
  through. **Verified, not just reasoned through** — `schema.test.ts`'s new
  "restricts deleting a stop whose day still has itinerary items" test
  exercises exactly this composed cascade-then-restrict chain, and it
  passed on the first real run against the actual generated migration, not
  after iterating on a mistaken assumption.

**`visits.trip_id`'s new FK is `set null`, with a documented, deliberate gap
around `link_source`.** A visit must survive its trip being deleted
(CONCEPT.md: "a visit never requires a trip") — `set null` achieves that for
`trip_id` alone. It does **not** also clear `link_source` (`'auto'`/
`'manual'`), which the Data model notes require to be null iff `trip_id` is
null — a hard trip delete would otherwise leave a visit with `trip_id: null`
but a stale `link_source: 'manual'`. Documented in the column's own comment
and locked in with a test (`schema.test.ts`) proving the gap is real, not
hypothetical, so `T.11`'s eventual trip-delete action knows it must
explicitly clear `link_source` for affected visits in the same transaction
— this schema alone cannot make that invariant hold through a hard delete.

**Dates are plain `YYYY-MM-DD` text, not millisecond timestamps** —
`trips.start_date`/`end_date`, `stops.arrive_date`/`depart_date`,
`trip_days.date` all follow the auto-link algorithm's own framing (SPEC.md:
compares a visit's *local calendar date* against a trip's derived range,
never a raw UTC instant). A stop/trip has no single timezone of its own in
phase 1, so a calendar-date string sidesteps needing one just to store
"arrives September 1st."

**`T.10`'s own review checklist item — "app-layer check enforces exactly
one of `attachments.trip_id`/`trip_day_id` set" — built as a small, pure,
schema-independent validator** (`_lib/attachments.ts`'s
`validateAttachmentTarget`), not folded into a full attachments CRUD module
(that's `T.11`'s job). Deliberately not a DB `CHECK` constraint, matching
SPEC.md's own framing ("app-layer check... covered by a unit test, not just
a comment") — confirmed via a `schema.test.ts` case that the DB layer alone
genuinely allows both columns set simultaneously, so the validator is
carrying real weight, not redundant with a constraint that would have
caught it anyway.

Full check suite clean: `format:check`, `lint`, this package's `typecheck`,
`design:tokens:check`, and all 154 travellog tests (138 existing + 16 new:
11 in `schema.test.ts` covering every new table's cascade/restrict/unique
behavior, 5 in `attachments.test.ts` for the XOR validator) pass.

**`T.9` — Slice 1 hardening & polish pass (`0.11.0`).** A full live pass
against `CONCEPT.md`'s Slice 1 + Web UI sections, driving the real dev
server rather than reading code — this task's own charter ("fix gaps found
live") only works if the audit actually happens live. Three real gaps found
and fixed, plus two long-standing coverage gaps finally closed by testing
paths this project had never actually exercised end to end before.

**Gap 1 — the root redirect sent a fresh user straight to a "coming soon"
placeholder.** `app/page.tsx` redirected `/travellog` → `/travellog/trips`,
correct per `SPEC.md`'s own Routes section for the *finished* product (Trips
becomes the real browse/manage/share hub once `T.13` ships it), but landing
a brand-new user on Trips' `EmptyState` today directly undercuts
`CONCEPT.md`'s own Slice 1 framing — "ships standalone and useful... check-in
ships first because it's the daily-use half." The sidebar makes Check-ins
one click away, so this was never a true dead end, but it's a bad first
impression of a screen that already works. Fixed by redirecting to
`/travellog/checkins` instead, with a code comment and a `SPEC.md` Routes
note explaining this is deliberately temporary — move it back to
`/travellog/trips` once `T.13` ships Trips for real.

**Gap 2 — "per-place visit counts" was fully unbuilt**, despite being named
explicitly in `CONCEPT.md`'s Slice 1 scope ("place, visit, manual/GPS
check-in with note and photo, the visit history list, a map of visits,
per-place visit counts, and the Swarm ZIP importer"). Confirmed live, not
assumed: Belém Tower had two real visits in the seed/test data and neither
the timeline nor the detail panel showed any indication of that. Since
Trips (the more natural home for a per-place aggregate) doesn't exist until
`T.13`, added it to the one place a "place" is currently surfaced
individually — `getVisitDetail` (`_lib/queries.ts`) now runs a `COUNT(*)`
across the caller's own visits at that `placeId` (own `Promise.all` alongside
the existing photos query, not a separate round trip) and
`CheckinDetailPanel` shows "Visited N times" via the DS's `history` icon,
**only when N > 1** — showing "Visited 1 time" on every single-visit check-in
would be noise, not signal. Two new tests in `queries.test.ts` cover the
count (including that it updates to reflect both visits once a second one
exists) and per-user scoping (a same-tenant other user's visits to the same
place never leak into the caller's count). Verified live end-to-end, not
just unit-tested: opened Belém Tower's detail panel (showed "Visited 2
times" against real seeded data), confirmed a single-visit place correctly
shows no count line, then checked in at Belém Tower a third time through the
real mobile flow and watched the count update to "Visited 3 times" live.

**Gap 3 — a stale code comment misattributed future scope to this task.**
`CheckinDetailPanel.tsx`'s doc comment claimed edit/delete UI was "`T.9`'s
job per SPEC.md" — it never was; `CONCEPT.md`'s Check-ins section scopes web
explicitly to viewing (plus an unlink action once trips exist), and this
task's actual deliverables (this file, above) never mention it either.
`updateVisitAction`/`deleteVisitAction` already exist server-side from `T.4`
with their own authz tests, just with no web UI hook — reasonable
forward-built plumbing, not dead code, and not a gap to close here. Left the
actions alone; corrected the comment so a future task doesn't inherit a
false pointer.

**Two real coverage gaps closed, not code gaps — paths that had never
actually been exercised live before this task, both flagged explicitly in
earlier status entries as unverified:**

- **A real photo, uploaded through the actual mobile check-in flow, had
  never been confirmed to render anywhere.** `T.7`'s own status entry
  called this out directly ("Not independently live-verified: an actual
  photo file upload through a real picker — this environment can't drive a
  native file-picker dialog"), and the one photo that existed in seed data
  pointed at a storage object that was never actually uploaded (a
  deliberate fixture for `T.6`'s "drops a missing photo instead of
  throwing" regression, confirmed by reading that code's own comment
  before assuming it was a bug). Verified for the first time this task,
  using the same `File`+`DataTransfer`+synthetic-`change`-event technique
  `T.8` used for ZIP uploads: constructed a real 1×1 JPEG, injected it into
  the check-in flow's file input, completed a real check-in against Belém
  Tower, and confirmed via `document.querySelectorAll('img')` in the live
  page that the resolved `/api/storage/[token]` signed URL actually loaded
  (`naturalWidth`/`naturalHeight` both `1`, `complete: true`) — not just
  that an `<img>` tag existed. Full pipeline confirmed working end to end:
  upload → `sdk.storage` → signed URL → render.
- **A dev-console hydration-mismatch error, seen once, was investigated
  rather than assumed benign or assumed a regression.** Navigating to
  `/travellog/checkin` in a tab that had just lived through several Fast
  Refresh cycles (from this task's own edits) showed a React `useId()`
  attribute mismatch (`SuggestionInput`'s generated `id`/`aria-controls`
  differed between server and client render). Rather than write it off,
  reproduced the exact same navigation in a completely fresh tab with no
  prior HMR history — zero console errors — confirming this was a dev-mode
  Fast-Refresh artifact (React's internal id counter diverging across a
  live-reloaded module graph), not a real, production-observable bug.
  Consistent with this project's established practice of checking a fresh
  tab specifically because a reused tab's history can misattribute a
  transient artifact as a live regression.

**Also checked and confirmed already correct, no changes needed:** every
Slice 1 web surface's loading/empty/error states (`Check-ins` has a real
`loading.tsx` and a clear two-CTA empty state; `Trips`/`Planner`/`Settings`
render proper `EmptyState`s, not dead ends; the root `error.tsx` boundary
matches the DS convention); the Import flow's malformed-file handling
(`readSwarmCheckins` runs synchronously at upload time, before any job or
`travellog_import_jobs` row is created, so a bad ZIP never reaches — and can
never get stuck in — the job-level "failed" + "Try again" retry path,
confirmed live by uploading a ZIP with no `checkins.json` and getting an
immediate inline `400` with zero job created); `MainDetailSplit`'s
narrow-viewport behavior (already a known, documented, `T.5`-era limitation
— `CONCEPT.md`'s "Deferred, not yet planned" explicitly excludes mobile web
layout from this concept-review pass, so not re-litigated here); and
`TravellogHeader`'s missing account-menu half (already tracked as `T.5a`'s
own explicit, deliberate scope, not an oversight).

Full check suite clean: `format:check`, `lint`, this package's `typecheck`,
`design:tokens:check`, and all 138 travellog tests (136 existing + 2 new for
`placeVisitCount`) pass.

**`T.8` — Swarm importer (`0.10.0`).** A resumable `sdk.jobs`-backed
importer turning an uploaded Swarm export ZIP into `travellog_places`/
`visits`/`visit_photos` rows, triggered from the Check-ins screen.

Built: `_db/schema.ts`'s `travellog_import_jobs` table (status, storage key,
platform job id, per-kind counters, a resume `cursor`, `errorMessage`) —
the durable, plugin-owned unit of progress, which survives a crashed
platform job attempt even though the platform's own `plugin_jobs` row for
that attempt doesn't; `manifest.json`'s new `jobs` array registering
`type: 'import.swarm'` → `app/_jobs/import-swarm.ts`; `_lib/swarm-import.ts`
(pure parsing — `readSwarmCheckins()` unzips with a cumulative-decompressed-
size zip-bomb guard mirroring `runtime/src/portability/bundle.ts`'s own,
`mapSwarmCheckin()` maps one raw checkin defensively, returning `null`
rather than throwing for a checkin missing an id/venue, and
`offsetMinutesToIanaZone()` maps Swarm's minute-offset field to an
`Etc/GMT∓N` zone for the whole-hour case); `_lib/import-jobs.ts` (CRUD for
the tracking row); `_lib/visits.ts`'s `isVisitAlreadyImported()`/
`addVisitPhoto()` and `_lib/places.ts`'s `findOrCreateImportedPlace()`
(reuses an existing place by `sourceRef` instead of creating a duplicate
venue on every re-import); the job handler itself,
`app/_jobs/import-swarm.ts`; the upload Route Handler,
`app/(home)/checkins/import/upload/route.ts` (same 1 MB-server-action-cap
reasoning as `T.7`'s photo upload, capped at 200 MB); `actions.ts`'s
`getLatestImportJobAction()`/`resumeImportAction()`; and the status UI,
`_components/ImportStatus.tsx` (upload form, 2s-interval progress polling
while active, completed/failed summaries, a "Try again" upload zone on
failure).

**The Swarm export field mapping is still inferred from third-party
tooling, not verified against a real export file.** This task's own spec
note calls this out as the thing to lock last, not first, and that
verification still hasn't happened — `CONCEPT.md`'s open question 5 stays
open. `swarm-import.test.ts`'s 23 tests cover the inferred shape
thoroughly (bare-array vs. `{items:[...]}` wrapper, nested-folder
`checkins.json`, missing/malformed fields, the whole-hour timezone mapping)
but can't substitute for a real export. Live verification below therefore
used a hand-built fixture ZIP, not a genuine Swarm export.

**Design decision, changed mid-build: no `dedupeKey` on the job enqueue.**
The first draft passed `dedupeKey: importJobId` to both `sdk.jobs.enqueue()`
call sites (upload, resume), reasoning it would prevent double-processing.
Reverted before it shipped: the platform's job worker deliberately never
auto-reclaims a job stuck in `'running'` after a crash (an operator must
investigate via admin health — `runtime/src/jobs.ts`'s own doc comment), so
a `dedupeKey` matching an "already active" job would treat a genuinely-dead
job as still-active forever, making the resume action a permanent no-op for
exactly the crash scenario it exists to fix. Closed the race at the
database level instead: `importOneCheckin()` catches a unique-constraint
violation from `createVisit()` (the `(tenant_id, source, external_ref)`
index from `T.2`) and treats it as "already imported, skip" — covers the
resume-race case where a crashed attempt inserted the visit but never
persisted the advanced cursor.

**A real platform-level bug found and fixed, not a plugin-local
workaround.** Live end-to-end testing (upload → job runs → check-ins
appear) failed every single time with "the uploaded export is no longer
available in storage," even for a brand-new upload — despite a raw table
dump (bypassing Drizzle, on the same DB connection the failing query used)
proving the row and bytes were both genuinely present. Root cause:
`sdk.storage.put()`'s `ownerUserId` ownership check
(`packages/db`'s `canAccessStorageObject`) has no background-invocation
fallback for `userId` — unlike `sdk.db.getClient()`'s `pluginId`, which
already falls back to a `runWithBackgroundPlugin()` `AsyncLocalStorage`
context for exactly this situation, `JobContext` carries no user identity
at all, so a job handler's resolved `userId` is always `null` and an owned
object becomes permanently unreadable from the only code that ever reads
it. Two-part fix: (1) a real platform fix, generalizing `sdk.db.getClient()`'s
existing background-context pattern to `sdk.storage.*` too
(`packages/sdk/src/storage.ts`'s `storageContext()` now catches
`next/headers()`'s throw outside a request instead of propagating it;
`runtime/src/sdk-host.ts`'s new `resolveStorageContext()` falls back to the
same background-plugin context `db.getClient()` uses, across all five
storage methods) — this closes the *plugin-id* half of the gap generically
for every plugin; (2) since no equivalent identity exists for *user* id (a
job is plugin-scoped, not inherently user-scoped — `JobContext` has nothing
trustworthy to carry), the upload route deliberately omits `ownerUserId`
from this one `put()` call, documented in the route's own comment along
with the accepted tradeoff (an unowned object is invisible to the
account-deletion storage sweep; deferred to a future `T.23` portability
`provideDelete` handler). The photo-fetch `put()` inside the job handler
correctly keeps `ownerUserId` — those objects are read back later via
`getVisitDetailAction`, a real request with real session, not a background
job. Generalized in `docs/architecture-rules.md`/`CLAUDE.md` (platform
repo) as a footgun any plugin combining owned `sdk.storage` objects with
`sdk.jobs`/`sdk.schedules` would hit identically; `packages/sdk` bumped
`1.45.0` → `1.46.0` (minor — `StorageContext.pluginId` widened to
`string | null`, a host-implementer-facing type change per NFR-04) with a
`docs/upgrade.md` migration note, `runtime` bumped `0.91.0` → `0.91.1`
(patch), platform root bumped `0.101.0` → `0.101.1` (patch, ad-hoc fix). A
regression test locks in the upload route's `ownerUserId`-omission specifically
(`(home)/checkins/import/upload/__tests__/route.test.ts`); the ownership-check
mechanism itself already had coverage in `packages/db`'s own
`platform-db.pg.test.ts`, just never exercised from a background-job angle
before this.

**Verified live end-to-end, not just the check suite** (a hand-built
fixture ZIP — see the field-mapping caveat above): uploaded a 3-checkin
fixture through the real upload route (`javascript_tool`-constructed
`File`/`FormData`, since this environment can't drive a native file
picker); the job ran to completion and the import status card correctly
read "Last import: 3 check-ins (2 photos skipped)"; navigating to
`/travellog/checkins` showed the imported check-ins in the timeline
alongside existing ones; server logs showed both photo fetches failing
cleanly (`404`, then a DNS/network `fetch failed` on a second, deliberately
unresolvable fixture URL) and logged as skips, never aborting the job —
live confirmation of the review checklist's third item, not just the unit
test. The other two review-checklist items (resume-from-cursor, re-run
creates no duplicates) are verified by `import-swarm.test.ts`'s dedicated
tests against the real job handler and a real ephemeral DB, including a
realistic crash-mid-insert race (a visit inserted but the cursor never
advanced) — not independently re-verified by actually killing the dev
server mid-job live, which this environment can't do cleanly.

Full check suite clean: `format:check`, `lint` (scoped to every touched
file — plugin, `packages/sdk`, `runtime`), this package's `typecheck`,
`design:tokens:check`, and all 136 travellog tests (83 existing + 53 new:
44 across four new test files — `swarm-import.test.ts` (23),
`import-jobs.test.ts` (7), `import-swarm.test.ts` (8, the job handler),
`upload/route.test.ts` (4) — plus 9 extending `places.test.ts`/
`visits.test.ts`) pass, alongside 4 new platform-side tests
(`runtime/src/__tests__/sdk-host-storage-routing.test.ts`) and the full
existing `packages/sdk`/`runtime` suites (all passing, unaffected).

**`T.7` — Check-in creation (mobile) (`0.9.0`).** The three check-in paths
from `CONCEPT.md` — search-first, GPS "check in here", manual free-text —
converging on one confirm step (note + photo, both optional). Per this
task's own scope note, screen placement/layout is deliberately deferred to
a mobile concept-review pass that hasn't happened yet; this builds the real
server-action-consuming logic and a plain, functional screen, not a
finished design.

Built: `_lib/use-current-position.ts`'s `useCurrentPosition()` (wraps
`navigator.geolocation.getCurrentPosition`, three-state idle/granted/denied/
unavailable machine, never throws); `actions.ts`'s
`reverseGeocodePlaceAction()` (the GPS path's single best-guess place,
composing the same merged place provider `T.3`/`T.3a` already built — the
manual provider always returns `null` here, so this always falls through to
the OSM adapter's real reverse-geocode endpoint); a new Route Handler,
`checkin/upload-photo/route.ts`; and the screen itself,
`app/checkin/page.tsx` — a two-step client component (find → confirm)
outside `(home)/`, so it never inherits `ThreeColumnLayout`'s sidebar
(confirmed broken below 768px since `T.5`) before the page even loads.

**Photo upload is a Route Handler, not a server action — a deliberate,
precedented choice, not an oversight.** Next.js server actions default to a
1 MB request-body cap; a real camera photo routinely exceeds that. Rather
than raise `experimental.serverActions.bodySizeLimit` platform-wide in
`runtime/next.config.ts` for one plugin's one upload, this mirrors
`runtime`'s own Warden chat route, which hit the identical constraint for
message attachments and solved it the same way (see that route's own doc
comment) — the client uploads to `checkin/upload-photo` first and gets back
a `storageKey`, then passes that into `createVisitAction`'s existing
`photos` field, unchanged from `T.4`. Caps at 8 MB (matching Warden's
`MAX_ATTACHMENT_BYTES`) and requires an `image/*` content type; both
checked before any bytes are written to `sdk.storage`.

**A real bug caught and fixed before it shipped, not found live — code
review of my own first draft, not a report:** rendering `<img
src={URL.createObjectURL(photo)}>` directly during render would mint a new
(and leaked — never revoked) blob URL on every re-render of the confirm
step, not once per actual photo selection. Fixed by moving it into a
`useEffect` keyed on `photo`, storing the URL in its own state, and
revoking the previous one in the effect's cleanup — the same
object-URL-lifecycle pattern any file-preview UI needs, just easy to get
wrong by inlining the call in JSX.

**The note field is this flow's deliberate fast path, reconciling two
CLAUDE.md rules that read as in tension for this screen.** The hard rule
says a quick-entry field commits on Enter *and* blur (iOS's Done key only
fires blur); its own stated exception says a field inside a form with an
always-visible submit button should *not* commit on blur. This screen has
both: an always-visible "Check in" button (so the field's own commit
behavior is never the only way to finish) *and* the note field wired to
`useCommitOnEnterOrBlur(handleCheckIn)`, so finishing the note is itself a
valid way to complete the check-in — matching how a live check-in is
meant to be fast (type a short note, hit Enter or tap Done, done), not a
multi-field form filled in top-to-bottom before a separate submit. The
field is deliberately the *last* one before the button (after the photo
picker), so a normal pass through the screen reaches it once a photo (if
wanted) is already attached — reaching it early by tabbing out of order
still completes the check-in, same as the button would.

**Verified live end-to-end, every path, in the real browser — not just the
check suite:**

- **Search-first**, against the real public Nominatim endpoint (not
  stubbed): typing "Belém Tower" surfaced the existing local seed place
  first (`Landmark · Lisbon · Portugal`, ranked ahead of OSM's own "Torre de
  Belém"), confirming the merged provider's manual-first ordering carries
  through into this screen unchanged from `T.3`. Selecting it moved to the
  confirm step with no page navigation.
- **Manual create**, via `SuggestionInput`'s "create" row: a nonsense query
  ("Zzqxvptesting Cafe") correctly returned zero matches plus the create
  row; selecting it created a real `travellog_places` row (no
  category/location line shown, correctly — nothing to show) and completed
  a real check-in.
- **GPS "check in here" — denied path**, the one this task's review
  checklist calls out explicitly: the preview browser has no granted
  geolocation permission, so this exercised the real, if unavoidable in
  this environment, "denied" branch — the card's hint text switched to
  "Location access denied — search for your place below instead" and the
  search field stayed fully usable throughout. The "granted" happy path
  (a resolved coordinate → `reverseGeocodePlaceAction` → a suggestion
  card) isn't independently live-verified beyond this — `actions.test.ts`
  covers `reverseGeocodePlaceAction` resolving a real Nominatim-shaped
  response directly, and the UI branch is the same conditional-render
  pattern already proven live for the other three `position.status`
  values.
- **Note commits on Enter**: confirmed precisely, not just via the
  browser tool's own key-press action — that action's "Return" didn't
  reliably map to `KeyboardEvent.key === 'Enter'` in this environment (a
  tooling quirk caught mid-verification, not a bug in the shipped code),
  so this was re-verified by dispatching a real `key: 'Enter'`
  `KeyboardEvent` directly via `javascript_tool` and confirming both the
  redirect to `/travellog/checkins` and the note's exact text in the new
  entry's detail panel.
- **Note commits on blur**: typed a note, then clicked a link elsewhere on
  the page (never the "Check in" button) — the blur handler fired first,
  completed the check-in, and `router.push` landed on `/travellog/checkins`
  before the link's own navigation had a chance to fire, with the note
  correctly saved.
- **"Change"** returns to the find step with the previous search query
  still in the field (intentional — `changePlace()` resets the selected
  place/note/photo but not `query`, so picking a different result from a
  near-identical search doesn't mean retyping it).
- Not independently live-verified: an actual photo file upload through a
  real picker — this environment can't drive a native file-picker dialog.
  Covered instead by `checkin/upload-photo/__tests__/route.test.ts`'s
  6 tests (auth-required, no-file/non-image/empty/oversized rejections,
  and a valid upload asserting the real `sdk.storage.put()` call shape).
- Fresh-tab console checked clean after every interaction above (this
  session's established practice, after `T.6` found that a reused tab's
  console history persists stale errors across navigations and can be
  mistaken for a live regression).

Full check suite clean: `format:check`, `lint`, this package's `typecheck`,
`design:tokens:check`, and all 83 tests (74 existing + 9 new: 3 for
`reverseGeocodePlaceAction`, 6 for the upload route) pass.

**`T.6` — Check-ins screen (web): timeline & detail (`0.8.0`).** The visit
log, view-only, as a read-side projection — the first screen with real data
end to end.

Built: `_lib/timezone.ts` extended with `localDateKey()`/`formatLocalTime()`
(cached `Intl.DateTimeFormat` per zone); `_lib/day-grouping.ts`'s
`groupByDay()` (Today/Yesterday/plain-date labels, grouping consecutive
same-local-day visits — each visit grouped by **its own** `tzIana`, not a
shared viewer zone, per `CONCEPT.md`); `actions.ts`'s
`getVisitTimelinePageAction()`/`getVisitDetailAction()`;
`_components/CheckinsTimeline.tsx` (day-grouped card rows, click-to-detail,
"Load more" pagination, two-action empty state); `_components/CheckinDetailPanel.tsx`
(photos, date/time, category, note, companions, and a structurally-present
but inert trip badge + "Unlink" button — real wiring is `T.12`'s job, since
`tripId` stays `null` on every visit until then); the real
`app/(home)/checkins/page.tsx` Server Component, `loading.tsx`, and a
`checkins/import` placeholder page so `T.6`'s two "Import…" entry points
don't dead-end before `T.8` builds the real flow.

**A real architectural blocker, resolved by live-testing an assumption
rather than guessing: `ThreeColumnLayout`'s "conditional-child pattern" from
this task's own SPEC text does not work the way it reads.** `(home)/layout.tsx`
(`T.5`) already calls `ThreeColumnLayout` with exactly two children —
`TravellogSidebar` and `{children}` — and `{children}` is always exactly one
slot from React's perspective; there is no way for an individual page nested
under that shared layout to contribute a *third* sibling into the parent's
already-fixed `ThreeColumnLayout` call. Rather than assume a `<>detail &&
<div>...</div></>` Fragment returned from the page would get flattened into
separate slots by `ThreeColumnLayout`'s own `Children.toArray(children)`,
this was checked directly: a throwaway probe component was written to the
real `app/(home)/checkins/page.tsx` location (not the scratchpad directory —
first attempt put it there, which Next's module resolution can't reach, and
was immediately corrected), `pnpm generate` run, and the toggle exercised
live in the browser. Result: the Fragment's second child rendered as a
full-width block stacked *below* the first, not as a real third column —
`Children.toArray` does not flatten a Fragment child in this context.
Resolved with a new plugin-local component, `_components/MainDetailSplit.tsx`,
used *within* the "main" slot instead of trying to inject a true sibling
into the outer `ThreeColumnLayout` instance — its CSS
(`MainDetailSplit.module.css`) is a direct mirror of
`packages/ui/src/components/ThreeColumnLayout/ThreeColumnLayout.module.css`'s
own `.main`/`.detail` rules, so it reads as a real fourth column visually
while being a plain sibling div structurally. **This is the pattern `T.14`
(Trips detail panel) and `T.16` (Planner) should reuse, not rediscover** —
both sit under the same shared `(home)/layout.tsx` and will hit the
identical constraint.

**Two real bugs found live, both fixed before considering this done — verifying
in the browser (not just the check suite) is what caught them:**

1. **Pagination cursor bug.** `_lib/queries.ts`'s `getVisitTimelinePage`
   returned a non-null `nextCursor` whenever the result had at least one
   row, with no check for whether the page was actually full — so a
   "Load more" button rendered even for a 3-item timeline with a 30-item
   page size, and would have kept rendering (harmlessly, but wrongly) after
   every subsequent empty fetch too. Caught immediately live-testing the
   seeded timeline (3 visits, "Load more" visibly present with nothing left
   to load). Fixed by gating `timelineCursorFor()` on
   `items.length === VISIT_TIMELINE_PAGE_SIZE`; added a regression test
   (`queries.test.ts`, "has no next cursor when the page is smaller than
   the page size") since the existing pagination test only ever created
   more than a full page and never exercised the "last page" case.
2. **A single missing photo crashed the entire detail panel — and the page
   around it.** `actions.ts`'s `getVisitDetailAction` called
   `sdk.storage.getSignedUrl()` for every photo via an unguarded
   `Promise.all`; `getSignedUrl` throws (`Storage object not found for key
   "…"`.) when the underlying storage row doesn't exist — confirmed as
   real, intentional host behavior in `runtime/src/sdk-host.ts`, not a bug
   in the SDK. One bad `storageKey` (in this case, the dev seed's own
   `seed/placeholder.jpg`, which was never actually uploaded) took down the
   whole server action, which surfaced client-side as an uncaught rejection
   and tripped the plugin's root `app/error.tsx` boundary — replacing the
   entire shell, sidebar included, with "Something went wrong" just from
   clicking one check-in row. A missing/expired storage object is a
   realistic production scenario (deleted upload, migration gap), not just
   a seed-data artifact, so this needed a real fix, not a seed-data
   workaround. Fixed by resolving each photo independently inside a
   try/catch and filtering out the ones that fail — a missing photo now
   degrades to "one fewer photo shown" instead of crashing the page.
   Verified both the failure (before the fix, live) and the fix (after,
   live, in a fresh browser tab with clean console history to rule out
   stale error logs from before the fix). Added three tests in the new
   `describe('getVisitDetailAction', …)` block in `app/__tests__/actions.test.ts`
   (ownership denial reads as not-found; a resolvable photo returns a
   signed URL, never the raw key; a mix of one resolvable and one
   unresolvable photo returns only the resolvable one) — the SDK mock
   gained a `storage.getSignedUrl` stub keyed by storage key, throwing for
   any key not explicitly registered, mirroring the real host.

**Verified live end-to-end** (dev DB migrations hadn't run at all for this
plugin — the dev server had been started before `travellog` existed in the
composed registry, so `runAllPluginMigrations()` never saw it; restarting
the dev server, which reruns that startup step, fixed it — not a `T.6` bug,
but worth knowing for future sessions hitting "no such table" on a plugin
that was clearly generated). Seeded via a temporary dev-only route
(`checkins/dev-seed/route.ts`, deleted before finishing — not part of the
deliverable) calling the existing `_db/seed.ts` helper `T.2` built but never
wired up. Confirmed: day-grouped timeline (Today/Yesterday/plain date)
renders card rows matching `docs/adhoc/web-checkins/01-checkins-populated.svg`;
clicking a row opens the detail column with no route/URL change and
highlights the active row; a note renders when present, is absent when not;
switching rows swaps the detail content cleanly; the close button clears
the detail column; navigating away to Trips and back to Check-ins does not
leave a stale selection (`MainDetailSplit`'s state lives in
`CheckinsTimeline`, which fully unmounts on route change); the empty state
(no visits) matches `02-checkins-empty.svg` including the two-action layout
("Import data" button + "Or check in from the Sovereign mobile app" hint,
since web genuinely has two escape hatches and neither is subordinate); the
"Import…" page-header button and the empty state's "Import data" button
both land on the real `checkins/import` placeholder page, no dead links.
Full check suite clean: `format:check`, `lint`, this package's `typecheck`,
`design:tokens:check`, and all 74 tests (70 existing + 4 new: 1 pagination
regression + 3 for `getVisitDetailAction`) pass. Mobile width not attempted
— confirmed still broken as `T.5`'s status entry already documented and
`CONCEPT.md`'s "Deferred, not yet planned" scopes out; not this task's job
to fix.

**`T.5` — Web shell: sidebar nav & `ThreeColumnLayout` scaffold (`0.6.0`).**
The first real UI task. Built: `app/(home)/layout.tsx` +
`_components/TravellogSidebar.tsx` (direct structural/CSS copy of
`sovereign-plugin-docs`'s `(home)/layout.tsx` + `DocsSidebar`), four
placeholder pages (`trips`/`checkins`/`planner`/`settings`, each
`PageHeader` + `EmptyState` naming the task that fills it in), and
`app/page.tsx` now redirects to `/travellog/trips` instead of rendering
`T.1`'s placeholder content.

**A real, load-bearing gap found and fixed before it shipped, not after**:
this task's own first-draft text (and `SPEC.md`'s "Web navigation &
layout" section) said the sidebar would carry the Launcher-back link,
following `sovereign-plugin-kanban`'s *original* K.16-era pattern. Checking
both sibling plugins' **current** source before building (not just this
spec's summary of them, written earlier) showed both had already moved
past that: `KanbanSidebar.tsx` explicitly no longer has one ("now lives in
`KanbanHeader`... doesn't need to be duplicated here"), and
`sovereign-plugin-docs` made the identical move for the identical reason.
Building the sidebar-only version as originally planned would have shipped
a real UX regression on day one — no way back to Launcher from any page,
since `shell: "minimal"` provides zero platform chrome and I would have
had no root layout at all otherwise (`T.1` never added one; a bare
placeholder page didn't need one yet). Fixed by adding a root
`app/layout.tsx` + minimal `TravellogHeader` (left side only: brand-badge
Launcher link + wordmark) now, and formally deferring the right side (apps
switcher, account menu — real components, ~250 combined lines in Docs'
equivalents, genuinely separate scope) as a new tracked task, `T.5a`,
rather than either silently skipping it or over-building it into this
task. `ToastProvider` added at the root too, same precedent, same reason
(ships now while nothing yet calls a toast, matching Kanban/Docs).

Added three new curated DS icons (`luggage`, `map-pin`, `route` —
`scripts/icon-list.ts`, `pnpm generate:icons`) for the sidebar nav, since
none of the existing 88 covered travel/check-in/route concepts — verified
each resolves in the installed `lucide` package before adding, not
guessed. Diff came back scoped to just the three additions (no incidental
unrelated-icon drift this time, unlike a prior regen elsewhere in this
codebase); the generated barrel needed one `prettier --write` pass the
generator itself doesn't apply.

**Verified live in the browser**, not just via the check suite:
registered account still signed in from `T.1` → `/travellog` redirects to
`/travellog/trips` (confirmed via the actual RSC chunk requested, not just
the rendered result) → clicked through all four sections, confirming both
visually (active-link styling correct on each) and via the network panel
(`T.5`'s literal review-checklist claim — clicking between sections only
fetches that section's own RSC payload and page chunk, never re-fetching
`(home)/layout.js` or the root `layout.js` — the sidebar and header
provably don't remount). No console errors. Also checked mobile width
(375px) specifically because `ThreeColumnLayout` has no responsive
behavior of its own (its own source says so) — confirmed it's genuinely
broken there (sidebar and content both squeezed into unusable slivers),
exactly as `CONCEPT.md`'s "Deferred, not yet planned" already says to
expect. Not fixed — mobile UI is out of scope for this pass by design, and
"confirmed broken as documented" is a different, better state than
"never checked."

Full check suite clean (`format:check` needed one `prettier --write` for
the regenerated icon barrel, noted above; `lint`, this package's
`typecheck`, `@sovereignfs/ui`'s `typecheck`, `design:tokens:check`, and
all 65 existing tests all pass unchanged — this task added no new testable
logic, only UI).

**`T.4` — Server data layer & actions: check-in (`0.5.0`).**
`_lib/action-result.ts` (`ActionResult`/`ok`/`fail`, mirroring
`sovereign-plugin-kanban`'s), `_lib/authz.ts` (`requireUser`,
`requireVisitOwner` — simpler than Kanban's membership-role checks since a
visit has exactly one owner, no sharing), `_lib/timezone.ts`
(`isValidIanaTimeZone`, a real `Intl`-based check rather than a static
zone list to keep in sync), `_lib/visits.ts` (`createVisit`/`updateVisit`/
`deleteVisit` — data layer, trusts the caller already resolved ownership),
`_lib/queries.ts` (the timeline and detail payloads — each query
ownership-scopes itself directly in its own `WHERE`, not via a separate
authz call a page could forget to make), and `actions.ts` (the first real
`'use server'` file in this plugin: `createVisitAction`,
`updateVisitAction`, `deleteVisitAction`, `searchPlacesAction`,
`createPlaceAction`).

**Design decisions made and recorded here, not fully dictated by the task
text:**

- **Plain typed-object action parameters, not `(prevState, formData)` /
  `useActionState`.** Check-in is a multi-step flow (search a place,
  possibly create one, then confirm) rather than one plain `<form
action={...}>` a single `useActionState` hook drives — matches how
  Kanban's own richer flows (`createProject`, `createBoard`) are typed,
  as distinct from its simplest single-field dialogs. `T.6`/`T.7` will
  show whether any of these individually fit the FormData shape once a
  real form exists; nothing here forecloses that.
- **`createPlaceAction`'s input type has no `source`/`sourceRef` fields at
  all** — every place created through it is unconditionally
  `source: 'manual'` server-side, never trusting a client-supplied value.
  `T.8`'s Swarm importer calls `_lib/places.ts`'s `createPlace()` directly
  with `source: 'import'`, bypassing this action entirely (it's a
  background job, not a per-place form submission). A test proves this by
  deliberately casting past the narrower type to confirm the server still
  ignores an attempted override, not just that the type system blocks it.
- **Query functions own their ownership scoping directly**, rather than
  composing a separate `requireVisitOwner` call a future page could
  forget — `getVisitDetail`'s `WHERE` clause itself excludes another
  user's visit, so "reading someone else's visit is impossible" holds even
  if a later RSC calls it without an extra guard.

**Verified — the review checklist's two explicit claims, both with real
tests, not just plausible-looking code:**

1. **Timezone round-trip.** Constructed real local wall-clock times (not
   invented offsets) for two zones — `America/New_York` in August (EDT,
   UTC-4) and `Asia/Kolkata` (UTC+5:30, deliberately non-whole-hour, since
   a half-hour-offset bug is exactly the kind of thing a naive
   hours-only implementation would hide) — stored them, then reconstructed
   the local wall-clock via `Intl.DateTimeFormat` against the *stored*
   `tzIana` and confirmed it matches the original input exactly. A third
   test proves the same instant reads differently when formatted against a
   *different* zone, so the round-trip tests aren't accidentally trivial
   (i.e., not silently ignoring the zone and just always matching).
2. **Ownership, not just tenant, scoping.** Every denial test uses **two
   users in the *same* tenant** (`user-1`/`user-2`, both `tenant-1`) —
   tenant-only scoping would have passed a same-tenant cross-user leak
   silently. Covers both the query layer (`getVisitDetail` returns `null`
   for another user's visit, even same-tenant) and the action layer
   (`updateVisitAction`/`deleteVisitAction` both deny with "not found," and
   a test confirms the target row is provably unmutated afterward, not
   just that the response said no).

29 new tests (65 total in the plugin now): the two verified claims above,
`createVisit`'s companions-JSON round-trip and transactional photo
insert, cursor pagination correctness (including two visits sharing the
exact same millisecond timestamp — the case a `happenedAt`-only cursor
would get wrong, `(happenedAt, id)` gets right), an unauthenticated call
throwing rather than silently failing, and `searchPlacesAction` running
with `fetch` stubbed so the OSM half of `T.3a`'s merged provider never
makes a real network call from this suite. Found and fixed 24 real lint
errors (`no-non-null-assertion`) across new source and test files while
closing this task — fixed with explicit narrowing (a shared `must()` test
helper, matching Kanban's own; an `if` check instead of `!` in
`queries.ts`'s cursor-condition construction) rather than suppressed.
Full check suite clean; dev server shows no new errors.

**`T.3a` — OSM place-search adapter (`0.4.0`).**
`app/_lib/providers/osm-place-provider.ts` (Nominatim `/search`+`/reverse`,
client-side rate-limited to Nominatim's own 1 req/s usage policy — a
request that would exceed it is skipped entirely, never queued/blocked,
per the review checklist's "degrades... without erroring" — plus an
in-process response cache) and
`app/_lib/providers/merged-place-provider.ts` (combines two providers,
primary's results first).

**Real design decision, not fully specified in the task text, made and
recorded here:** `getPlaceProvider()` now **merges** local and OSM results
rather than strictly falling back to manual only when OSM comes back
empty. Reasoning: `T.3`'s own manual search exists specifically so
re-visiting a place you've been to before doesn't mean re-typing it —
subordinating that to "OSM first, manual only as a fallback" would have
buried your own check-in history under generic new suggestions every
time. Local results are still returned first (a personal match is a
stronger signal than a new one), and the "falls back... when a search
returns nothing" checklist wording is satisfied at the composed level: if
both are empty, the caller still always offers "create new." Known,
accepted limitation: no de-duplication between a local match and an OSM
candidate that are the same real-world place — noted in
`merged-place-provider.ts`, not attempted in phase 1.

**`getPlaceProvider()` is now `async`** (was sync in `T.3`) — resolving
`NOMINATIM_BASE_URL` via `sdk.env.get()` is itself async, and the factory
is where that resolution belongs so no future call site has to plumb
config through itself. No existing caller broke — nothing downstream of
`T.3` had been built yet.

New manifest `env` declaration:
`NOMINATIM_BASE_URL` (default `https://nominatim.openstreetmap.org`,
namespaced at runtime to `SV_PLUGIN_FS_SOVEREIGN_TRAVELLOG_NOMINATIM_BASE_URL`
— verified against the real derivation in `packages/sdk/src/env.ts` rather
than assumed) — documented in a new plugin `README.md` (this repo didn't
have one yet; added now since an operator-facing env var needs a place to
be documented, matching `sovereign-plugin-docs`'s own precedent).

**Verified for real, not just mocked**: a single, real, policy-compliant
request against the actual public Nominatim endpoint (proper
`User-Agent`, one request, not part of the automated suite — hitting a
live third party on every CI run would itself violate the politeness this
task is about) confirmed the real response shape matches this code's
mapping assumptions exactly (`place_id`, `lat`/`lon`, `display_name`,
`name`, `type`, `address.{city,country,country_code,postcode}`) — not
just self-consistent with mocked test fixtures. The automated suite (17
new tests: response mapping, User-Agent header, viewbox biasing, non-2xx/
network-error/rate-limit degrade paths all returning `[]` and never
throwing, request caching, and the merge/config-resolution behavior in
`place-provider.test.ts` with `@sovereignfs/sdk` and `fetch` both mocked)
never touches the real network — 36 tests total in the plugin now, all
passing. Existing `place-provider.test.ts` (T.3's manual-only coverage)
split: manual-provider-specific behavior moved to
`manual-place-provider.test.ts` testing `createManualPlaceProvider`
directly; `place-provider.test.ts` now covers the factory's own
composition/config-resolution behavior. Full check suite clean; `pnpm
generate` confirms the new `env` declaration composes without error.

**`T.3` — Place provider interface & manual-first implementation
(`0.3.0`).** `app/_lib/place-provider.ts` (the `PlaceCandidate`/
`PlaceProvider` interfaces + `getPlaceProvider(db, ctx)` factory),
`app/_lib/providers/manual-place-provider.ts` (the only concrete
implementation so far — never imported except by the factory),
`app/_lib/places.ts` (`createPlace()`, deliberately outside the
`PlaceProvider` interface — see the Data model section's note on why), and
`app/_lib/geo.ts` (`distanceMeters`, haversine — used now for near-sorting
search results, and already shaped for the deferred Phase 2a proximity
reordering to reuse later with zero changes).

**Found and fixed a real gap in this spec's own interface before writing
any code**: the first-draft `PlaceCandidate` had no way to distinguish "an
existing place, reuse it" from "a fresh candidate, materialize a new row"
— every search-result selection would have called `createPlace()` again,
silently duplicating a place each time someone re-selected it. Added
`existingPlaceId?: string`, populated by the manual provider from the real
row id, left undefined for any future external-provider candidate. Caught
by reasoning through the caller's flow before implementing, not discovered
via a failing test — see the Data model section for the full note.

Design decision not fully specified in the first draft, made now and
recorded here rather than silently decided: **the factory takes `(db,
ctx)` and returns a provider closed over that context**; the
`PlaceProvider` interface's own `search`/`reverseGeocode` methods stay
argument-free beyond query/coordinates, matching the interface as written
in the Data model section. `createPlace()` was kept out of the provider
interface entirely — an external provider (`T.3a`) finds candidates, it
was never going to own writing local rows.

Verified with 13 new tests (4 test files, 19 total in the plugin now) against
the real migrated schema from `T.2` — `place-provider.test.ts` covers
partial/case-insensitive match, tenant scoping, matching regardless of a
place's original `source` (an imported place is just as findable as a
manual one), an empty result for no match (never an error, so the caller
can always offer "create new" per the review checklist), near-sort with a
coordinate-less place sorting last rather than being excluded, and
`reverseGeocode` always returning `null`; `places.test.ts` covers the
review checklist's explicit "no coordinates" case — `lat`/`lng` stay
`null`, never defaulted to `0`/`0`, which would have silently placed an
unpinned café in the Gulf of Guinea. Full check suite clean; no new UI
surface in this task, so nothing to verify live in the browser beyond
confirming the dev server shows no new errors (it doesn't).

**`T.2` — Slice 1 data model & migrations (`0.2.0`).** `travellog_places`,
`travellog_visits`, `travellog_visit_photos` per the Data model section,
including `visits.tripId`/`linkSource` (present now, inert until `T.10`, no
FK yet since `travellog_trips` doesn't exist).

**Corrected a real error in this spec's own Data model section while
implementing** (see the "Correction from this spec's first draft" note
above): verified against `docs/plugin-database.md` and
`sovereign-plugin-kanban`'s actual repo that `drizzle-kit generate
--dialect postgresql` cannot read a `sqliteTable()` schema at all — a
genuine `schema.postgres.ts` twin is mandatory, not optional, and every
timestamp column in it must be `bigint({ mode: 'number' })` (Postgres's
`integer` is a real 32-bit type; a Unix-ms timestamp already overflows it
by ~800×, a documented real production failure elsewhere in this
codebase). Built both files from the start rather than discovering this
gap after generating.

`drizzle-kit generate` (run once per dialect, against each config)
produced clean migrations for both; the Postgres one needed the
documented manual fix — two `REFERENCES "public"."…"` qualifiers
(`travellog_visit_photos → travellog_visits`, `travellog_visits →
travellog_places`) stripped to unqualified `REFERENCES "…"`, since a
plugin's Postgres tables live in `plugin_<slug>` via `search_path`, never
`public`. Not committed/pushed anywhere yet (developer instruction) — the
generated SQL was inspected by hand before and after this fix, not just
trusted.

`_db/position.ts` (fractional ordering, needed now for
`visit_photos.position` and reused as-is for stops/itinerary items from
`T.10`), `_db/client.ts`/`_lib/db.ts` (`sdk.db.getClient()` wrapper),
`_lib/ids.ts` (nanoid), and `_db/seed.ts` (3 demo places, 3 demo visits, 1
demo photo) all mirror `sovereign-plugin-kanban`'s equivalent files
structurally — same conventions, not reinvented.

**Verified, not just typechecked**: a new `_db/__tests__/test-db.ts`
(same ephemeral-file-over-`:memory:` pattern as Kanban's, for the same
reason — `@libsql/client`'s `transaction()` opens a fresh connection per
call, so a `:memory:` DB loses its migrated tables on first transaction)
+ `_db/__tests__/schema.test.ts` apply the real generated SQLite migration
against a throwaway file DB and exercise: every table exists post-migration
(the literal "migrations run clean" checklist item), the seed helper is
idempotent, the `(tenant_id, source, external_ref)` unique constraint
rejects a duplicate import while allowing a different `external_ref`
through (the checklist's other explicit requirement), a visit delete
cascades its photos, and a place delete is **restricted** while visits
still reference it (`ON DELETE RESTRICT`, deliberately not cascade — losing
a place should never silently delete someone's check-in history). All 6
tests pass. Full check suite (`format:check`, `lint`,
`design:tokens:check`, this package's own `typecheck`) passes clean; dev
server shows no new errors.

**`T.1` — Plugin scaffold & manifest (`0.1.0`).** Scaffolded by hand rather
than via `sv plugin new`/`create-plugin` (both tools default `shell:
"default"` and a minimal permission set; this plugin needed `shell:
"minimal"` and the full phase-1 permission list from day one, so it was
faster and more accurate to write `manifest.json` directly against this
file's own "Plugin identity"/"Manifest permissions" sections than to
scaffold-then-edit). Files: `manifest.json`, `package.json` (pinned
`0.0.0`), `tsconfig.json`, `css-modules.d.ts`, `.gitignore`, `icon.svg`
(map-pin glyph, Lucide-style), `app/page.tsx` (placeholder — session-aware
greeting only, per the generic scaffolder's own pattern), `app/error.tsx`
(the `sv-ui-design` skill's required unexpected-error boundary, added now
even though not explicitly listed in `T.1`'s deliverables — cheap to add
alongside the placeholder page and every other plugin in this repo ships
one).

Verified live, not just via the check suite: `pnpm install` (bare, per this
repo's own documented `.local`-plugin exception to `--frozen-lockfile`) →
`pnpm generate` composed the route cleanly (`runtime/app/(minimal)/travellog/`,
confirming the manifest validates and `shell: "minimal"` routes correctly)
→ `pnpm dev` (via the platform's `sovereign-dev` preview config) → registered
a throwaway dev account (`sv-ui-design`'s sanctioned verification pattern —
the existing dev DB already has real, non-test accounts, so `sv seed`
correctly refused to run) → confirmed `/travellog` renders with **no
platform header/footer** (the actual point of the `shell: "minimal"`
correction made while drafting this spec) and the Launcher tile shows the
right name/description/icon. No console errors.

Check suite: `format:check`, `lint`, and `design:tokens:check` all pass
repo-wide; `sovereign-plugin-travellog`'s own `typecheck` passes both
standalone and inside the full-repo `pnpm typecheck` run. **The full-repo
`pnpm typecheck` run itself fails**, but in `sovereign-plugin-kanban`
(`BoardView.tsx`/`ListColumn.tsx`, "Cannot invoke an object which is
possibly 'undefined'") — confirmed pre-existing and unrelated: that repo's
`git status` is clean (no uncommitted changes) and the error already exists
in its last committed state, `f8cbd56`. Not this task's to fix. `vitest`
has nothing to run yet — no test files exist until `T.3`'s server actions
land.

This is the second pass over this file — the first covered Slice 1's data
model and a placeholder "surfaces" sketch; this pass locks the actual web UI
(a concept-review conversation settled it: `ThreeColumnLayout`, a
Trips/Check-ins/Planner sidebar, and a `trip → stop → trip_day →
itinerary_item` model replacing the flatter `trip → trip_day` shape the
first pass had). Mobile UI has **not** been through that review yet and
stays intentionally unspecified below — see CONCEPT.md's "Deferred, not yet
planned."

---

## A note on drift from CONCEPT.md and the research doc

Both `CONCEPT.md` (this repo) and the platform's
`docs/research/0005-trip-planning-and-place-checkin-plugin.md` were written
before this spec, and the platform moved under a few of their assumptions in
the meantime. This spec reflects the **current** platform (verified against
`packages/manifest/src/schema.ts` and `docs/plugin-development.md` while
drafting), not the research doc's snapshot:

- **At-rest database encryption no longer exists as a manifest option.**
  The research doc recommended `database.requireEncryption: true`. That
  field — and the entire `database` manifest block, including the
  `isolation`/`dialect` sub-fields the research doc also cites — has been
  **retired**. Every plugin's database is unconditionally isolated now, and
  dialect follows the operator's instance-wide `DB_DIALECT`; there is
  nothing left for a plugin to configure. The load-bearing consequence the
  research doc worried about ("this pins the plugin to SQLite even on a
  Postgres instance") **no longer applies** — there's no way to pin dialect
  at all anymore, for any plugin. See "Encryption posture" below for what
  replaced RFC 0071.
- **Offline is no longer a flat boolean, and there's no separate
  offline-write permission to wait on.** The research doc's platform-gaps
  section describes RFC 0074's `offline: boolean` and a still-unbuilt RFC
  0078 `offline:write` permission/queue as the blocker for Slice 3. Both
  RFCs shipped and were then **superseded**; the manifest's `offline` field
  is now `z.enum(['offline-first', 'device-only'])`, and per its own schema
  comment, "both tiers imply local mutation, so no separate write permission
  is needed." See "Offline posture" below.
- **`sdk.device.geolocation` still does not exist.** Checked directly
  against `packages/sdk/src/device.ts`/`device-client.ts` — the only device
  capabilities implemented are `haptics`, `nativeNotifications`, `camera`,
  `biometrics`, and `secureStorage`. This spec proceeds on plugin-local
  `navigator.geolocation` (see "Location source" below).
- **Trip sharing needs its own confirmation before `T.14`.** This spec's
  data model and Trips detail-column design assume real shared trip access
  (another platform user can view/edit a trip they're added to), modeled
  directly on `sovereign-plugin-docs`'s folder sharing
  (`FolderShareButton`/`FolderShareDialog` + `sdk.directory`). This is an
  **inference** from "add/remove people" + a settings panel in the product
  conversation, not an explicit confirmation — flagged in both files' open
  questions. Verified while drafting: no extra manifest permission is
  needed for `sdk.directory` (checked `sovereign-plugin-docs`'s
  `manifest.json` — it lists no directory-specific permission).

Everything else in CONCEPT.md — the two-spine model, the decided scope (one
plugin, no reward mechanics), the three-slice build order — is unchanged and
this spec builds directly on it.

---

## Architecture

### Terminology

**"Check-in"** is the user-facing verb for creating a `visit` row.
**"Stop"** is the working term for a trip's ordered locations (place +
arrival/departure dates) — open to a better word per CONCEPT.md. **"Trip
Mode"** is the user-facing name for the Slice 3 day-navigation surface,
launched via "Start" on a stop's day view (mobile-only). Plan-spine/log-spine
are spec vocabulary only — never UI copy.

### Plugin identity

- **id:** `fs.sovereign.travellog` (reverse-DNS per platform convention;
  table slug prefix `travellog_`)
- **routePrefix:** `/travellog`
- **type:** `sovereign` (first-party plugin maintained by the project,
  installed from its own repo — the manifest schema requires a `repository`
  URL for this type)
- **shell:** `minimal` — **changed from this spec's first draft, which had
  `default`.** The web UI concept-review settled on the plugin self-
  rendering its own primary navigation via `ThreeColumnLayout` (a sidebar
  with Trips/Check-ins/Planner/Settings — see "Web navigation & layout"
  below), the same pattern `sovereign-plugin-kanban` and
  `sovereign-plugin-docs` both use `shell: "minimal"` for. Pairing a
  self-rendered sidebar with `shell: "default"` would double up navigation
  chrome — the platform's own header/footer rendering *around* the
  plugin's own sidebar. `minimal` removes that redundant platform chrome,
  matching Kanban's own documented rationale for the same choice. Per that
  precedent, the sidebar gains a plain Launcher link so desktop users still
  have a way back.
- **Versioning:** the plugin's version lives **only** in `manifest.json`;
  `package.json` stays pinned at `0.0.0` forever (platform convention).
- **`compatibility.minPlatformVersion`:** `"0.94.0"` — the manifest
  `offline` enum and RFC 0092 field-encryption helpers this spec relies on
  both need a reasonably current platform; bump if `T.1` lands against a
  newer baseline.

### Manifest permissions

Phase 1 (Slices 1–3):

- `auth:session` — session reads on every server action (first line of
  every action, no exceptions)
- `db:readWrite` — the plugin's isolated database (automatic per plugin now;
  no manifest `database` block needed)
- `storage:readWrite` — check-in photos, trip attachments (RFC 0044)
- `notifications:send` — Trip Mode reminders, import-complete notices, and
  "you were added to a trip" notices (RFC 0015)
- `jobs:write` — the resumable Swarm import job (RFC 0046)
- `data:export`, `data:import` — Sovereign-native takeout via
  `sdk.portability` (RFC 0007) — **separate from and additional to** the
  Swarm importer; see "Import design" below for why these are two different
  code paths that both need building.

Not requested in phase 1, reserved for later if picked up:

- `crypto:use` — only needed if/when the deferred field-encryption task
  (`T.24`) is implemented. Don't request a permission before the capability
  it gates actually does anything — see "Encryption posture."
- `device:*` — not needed; geolocation for phase 1 uses plain
  `navigator.geolocation`, which requires no manifest permission (it's a Web
  API, not an `sdk.device.*` call).

No `publicRoutes`, no `public: true` — every surface requires a session.
`sdk.directory` (trip sharing, `T.14`) needs no manifest permission of its
own — verified against `sovereign-plugin-docs`'s manifest, which uses the
same directory-search pattern with no extra permission listed.

### Encryption posture

The research doc flagged location history as "the most sensitive data class
the platform has handled" and leaned on RFC 0071 (`database.requireEncryption`)
to address it. RFC 0071 is retired — `packages/db/src/sqlite-encryption.ts`
now only keeps narrow primitives for a one-time legacy migration path, not
anything in the live server path. The current replacement is **RFC 0092,
App-level field encryption** (Implemented, shipped `v0.79.0`): plugin schema
code classifies a column's sensitivity via `@sovereignfs/sdk`'s
`encryptedText()`/`blindIndex()` helpers, and the **operator** decides via
`SOVEREIGN_ENCRYPT_CLASSES` whether that class is actually encrypted on
their instance. Unset/empty means plaintext, unchanged from today — nothing
about adopting this is mandatory for phase 1 to ship.

Phase 1 does **not** classify anything, deliberately:

- `place.lat`/`lng`, `visit.happened_at`, and every other column the map
  view, visit history, and auto-link engine filter/sort/range-query on
  **must** stay plaintext — RFC 0092's own documented limitation is that
  encrypted columns lose `LIKE`/range/`ORDER BY`, and those are exactly the
  operations Slice 1's map and Slice 2's auto-link depend on. There is no
  version of "encrypt the coordinates" that doesn't break the map.
- The only genuinely free-text, non-queried field in phase 1 is
  `visit.note`. Classifying it `sensitive` is a small, isolated, **optional**
  follow-up (`T.24`, explicitly deferred out of Slices 1–3) once the core
  product works — not a blocker, and not silently skipped either.
- This is a narrower, more honest claim than the research doc's "encrypt the
  whole database": most of what makes a check-in useful (where, when) is
  exactly what the app needs to query, and RFC 0092 cannot encrypt that
  without breaking the product. Operators who need stronger protection than
  disk/volume-level encryption for the queryable fields should be told this
  plainly in the plugin's own docs, not have it silently overpromised.

### Offline posture

The manifest's `offline` field is now `z.enum(['offline-first',
'device-only'])` (superseding RFC 0074/0078's boolean + separate write
permission, per `packages/manifest/src/schema.ts:373-401`). Travellog wants
**`offline-first`**: the device holds a real replica kept fresh in the
background, the server stays the source of truth — matches Trip Mode's
actual requirement (check in and read your itinerary in a dead zone while
traveling), and unlike the old model, **local mutation is implied by the
tier itself** — check-in-while-offline is not blocked on a separate,
unshipped write-queue RFC.

Concretely:

- `offline: 'offline-first'` is declared on the manifest starting in
  **`T.21`** (Slice 3), not before — Slices 1–2 have no offline requirement
  of their own, and declaring it earlier would mean shipping the client-side
  replica/sync plumbing before there's a surface that needs it.
- The bare `routePrefix` page (`/travellog`) is the one offline-capable
  entry point per the manifest field's own contract, and now redirects to
  `/travellog/trips` (see "Routes") — it must render a user-neutral shell
  and hydrate everything else client-side, not per-user SSR, so the
  platform can safely precache it. **Re-check whether a redirecting bare
  route still satisfies that contract when `T.21` actually starts** — this
  wasn't a consideration when the field was first designed against a
  single-tab plugin.
- Workstream 0008 (offline-first architecture) is still in progress
  platform-wide as of this writing — re-check its current state before
  starting `T.21` in case the concrete client-side replica/sync API has
  moved since this spec was drafted.

### Location source

`navigator.geolocation` directly (plugin-local) — `sdk.device.geolocation`
doesn't exist (verified against `packages/sdk/src/device.ts` while drafting
this spec) and CLAUDE.md currently reserves `sdk.device.*` for the post-v1
native shells. This is a narrow, precedented exception (the same one RFC
0058/mobile docs anticipate for browser/PWA-only capabilities), not a new
pattern. If `sdk.device.geolocation` ships before mobile check-in capture
is built, switch to it then.

### Web navigation & layout

Settled via the web UI concept-review (see CONCEPT.md's "Web UI (decided)")
— **do not reopen without cause**. Applies to web only; mobile is a
separate, not-yet-designed tree.

- **`ThreeColumnLayout`** (`@sovereignfs/ui`) is the plugin's whole-app
  shell: sidebar + main + optional detail column. Exactly the same
  component and usage pattern as `sovereign-plugin-docs`'s
  `app/(home)/layout.tsx` + `DocsSidebar` — mirror that file's shape
  directly rather than re-deriving it (`T.5`). The detail column appears
  purely by being a truthy third child, driven by local component state
  (a selected id) — see `ThreeColumnLayout`'s own `ConditionalDetail`
  Storybook story for the canonical pattern.
- **`TravellogSidebar`** (`T.5`): top links **Trips**, **Check-ins**,
  **Planner**, a divider, then a bottom section (`margin-top: auto`) with
  **Settings**. Direct copy of `DocsSidebar.tsx`'s structure.
- **The Launcher-back affordance lives in a root `app/layout.tsx` +
  `TravellogHeader`, not the sidebar** — corrected from this section's
  first draft (which said the sidebar carries it) once implementation
  showed both `sovereign-plugin-docs` and `sovereign-plugin-kanban` had
  already moved past that into an identical root-level header pattern on
  every page, not just sidebar-having ones (needed for a future route with
  no sidebar at all, like Trip Mode, `T.19`). `TravellogHeader` ships
  `T.5`'s minimal left half only; the right half (apps switcher, account
  menu) is `T.5a`, deliberately deferred.
- **Routes and their column content** are detailed per-screen below (Data
  model → Data fetching contract → Routes).

### SDK usage

| Surface                      | Use                                                              |
| ----------------------------- | ----------------------------------------------------------------- |
| `sdk.auth.requireSession()`  | First line of every server action and API route                 |
| `sdk.db.getClient()`         | Plugin's isolated DB (zero-argument invariant — never work around it) |
| `sdk.storage.put/get/delete/list/getSignedUrl` | Check-in photos, trip attachments (RFC 0044) |
| `sdk.jobs.enqueue()`         | The resumable Swarm import job (RFC 0046)                        |
| `sdk.notifications.send()`  | Trip Mode reminders, import-complete notice, trip-share notice (RFC 0015) |
| `sdk.directory` (RFC 0041)   | User search for trip sharing (`T.14`) — same pattern as `sovereign-plugin-docs`'s `FolderShareDialog` |
| `sdk.portability.provideExport/provideImport` | Sovereign-native takeout (RFC 0007) — additional to, not the same as, the Swarm importer |
| `navigator.geolocation`      | Current position for GPS check-in and Trip Mode (Web API, plugin-local — see "Location source") |

### Hard platform rules that apply here

- Plugins import **only** `@sovereignfs/sdk` and `@sovereignfs/ui` — never
  `runtime/src` (ESLint-enforced).
- Every server action authorizes **inside the action**
  (`await sdk.auth.requireSession()`, then an explicit per-resource
  ownership/membership check) — route-level gating is never sufficient.
- All tables slug-prefixed `travellog_`; `tenant_id` on every user-scoped
  table.
- **Visits are private per user; trips can be shared.** Unchanged from the
  first draft for check-ins — a `visit` belongs to the `user_id` who
  created it, no sharing model. **Changed for trips**: a `trip` can be
  shared with specific platform users via `travellog_trip_members` (see
  "Data model" and the open question on whether this is the right model at
  all) — mirrors Kanban's board membership and Docs' folder sharing, not a
  new pattern for this platform. Only an explicit member (owner or member
  role) can view or edit a trip; there is still no tenant-wide visibility.
- Page padding/max-width come from `PageContainer` inside each column's
  content — no local root padding/max-width. `ThreeColumnLayout` itself is
  purely structural (sidebar/main/detail widths); `PageContainer` still
  governs padding within the main and detail slots.
- Quick-entry inputs (note field, place-name field) that commit on Enter
  must also commit on blur (`useCommitOnEnterOrBlur`) — iOS's Done key only
  fires blur.
- Intra-overlay navigation uses `<Link replace>` (overlays dismiss via
  `router.back()`).
- Only `--sv-*` semantic tokens in CSS; no hardcoded colors
  (`pnpm design:tokens:check` enforces this repo-wide, including any
  plugin-local map styling).
- User-facing strings say **app/trip/stop/check-in/place**, never "plugin".

---

## Data model

All tables in the plugin's isolated database. Application code queries
through **one** schema file, `app/_db/schema.ts` (`sqlite-core`) — a
plugin can no longer request a dialect, and Drizzle's query builder is
bound to the client connection rather than the table object, so this same
file works correctly against a Postgres-backed client too, **as long as
every column serializes identically** (plain `integer` for booleans/ids,
never a native `boolean`). **Correction from this spec's first draft:**
that is not the same as needing only one schema file — `drizzle-kit
generate --dialect postgresql` cannot read a `sqliteTable()`-based file at
all (it silently reports zero tables found), so a genuine second,
structurally-mirrored `app/_db/schema.postgres.ts` (`pgTable`) is required
purely to drive Postgres migration generation; application code never
imports it. Verified directly against `docs/plugin-database.md` and
`sovereign-plugin-kanban`'s actual two-file pair while implementing `T.2`.

**One deliberate divergence between the two files, not optional:**
timestamp columns. SQLite's `integer` affinity has no real width limit, but
Postgres's `integer` is a genuine 32-bit type (max 2147483647) — a Unix
_millisecond_ timestamp is already ~800× past that. `schema.postgres.ts`
must use `bigint({ mode: 'number' })` for every `_at`/`happened_at` column;
`schema.ts` keeps plain `integer`. This is not a hypothetical — Kanban hit
exactly this as a real production failure (`value "..." is out of range
for type integer`) before its Postgres twin was corrected; travellog's
Postgres twin uses `bigint` from the start. Fractional `position` columns
use `real` in `schema.ts` and `doublePrecision` in `schema.postgres.ts`.

**Foreign keys in the Postgres twin need a manual fix after every
`drizzle-kit generate`**: the generator always qualifies a `FOREIGN KEY`
target with the schema the table was declared in (`public`, since neither
file declares an explicit `pgSchema()`), but a plugin's Postgres tables
actually live in `plugin_<slug>`, reached via `search_path` — an
`ALTER TABLE ... REFERENCES "public"."other_table"` fails at migration
time. Strip the `"public".` qualifier by hand in the generated SQL; there
is no drizzle-kit flag that avoids this.

Generated migrations live at plugin root under
`migrations/{sqlite,postgres}/`. `tenant_id` and `user_id`/`owner_id` scope
every user-owned table. Timestamps (`created_at`, `updated_at`) on every
table; no soft-delete in phase 1 — deletes cascade.

```
travellog_places          id, tenant_id, name, category, lat, lng, address,
                           city, state, country, country_code, postal_code,
                           source ('manual'|'osm'|'google'|'import'),
                           source_ref, created_by, timestamps

travellog_visits           id, tenant_id, user_id, place_id, happened_at (ms
                           epoch UTC), tz_iana, tz_offset_minutes, note,
                           companions (JSON string[]), trip_id (nullable),
                           link_source ('auto'|'manual', null iff trip_id
                           null), source ('manual'|'gps'|'import:swarm'),
                           external_ref (nullable — import de-dup),
                           timestamps

travellog_visit_photos     id, visit_id, storage_key, position,
                           source ('upload'|'import'), created_at

travellog_trips            id, tenant_id, owner_id, name, start_date
                           (denormalized, cached — see notes), end_date
                           (denormalized, cached — see notes), timezone
                           (nullable), timestamps

travellog_trip_members     trip_id, user_id, role ('owner'|'member'),
                           added_by, created_at
                           — ⚠ ASSUMED, see Data model notes: only build
                           this if CONCEPT.md open question 2 confirms real
                           shared access rather than lightweight tags.

travellog_stops             id, trip_id, place_id, arrive_date, depart_date,
                           position (fractional, ordering), timestamps

travellog_trip_days        id, stop_id, trip_id (denormalized), date, title,
                           notes, timestamps

travellog_itinerary_items  id, trip_day_id, trip_id (denormalized), place_id
                           (nullable), title (required if place_id null),
                           planned_time ("HH:mm", nullable), is_fixed
                           (boolean, default false), position (fractional),
                           notes, timestamps

travellog_attachments      id, trip_id (nullable), trip_day_id (nullable —
                           exactly one of the two set, app-layer checked),
                           kind ('receipt'|'booking'|'accommodation'|'other'),
                           title, storage_key, created_by, created_at

travellog_import_jobs      id, tenant_id, user_id, source ('swarm'), status
                           ('pending'|'running'|'paused'|'completed'|
                           'failed'), total_items, processed_items,
                           photo_total, photo_fetched, photo_failed, cursor
                           (JSON, resume position), error_log (JSON),
                           platform_job_id (sdk.jobs JobRef id), timestamps
```

Notes:

- **`place` fields mirror the Swarm export shape deliberately** (`address`,
  `city`, `state`, `country`, `country_code`, `postal_code` instead of one
  free-text address blob) — per the research doc's finding that the Swarm
  check-in object maps "almost one-to-one" onto this model, and per its own
  caveat, this mapping is **still unverified against a real export file**
  (see `T.8`).
- **`companions` is stored, not built UI for, in phase 1** on `visits`.
  Swarm's export has a `with[]` field; carrying it through import avoids
  silently dropping data, but no manual "add companions" UI is built until
  there's a reason to.
- **A trip's `start_date`/`end_date` are a denormalized cache, not
  independently editable.** They're recomputed server-side, in the same
  transaction, whenever a stop is added/edited/removed/reordered — first
  stop's `arrive_date` → trip `start_date`; last stop's `depart_date` →
  trip `end_date`. This exists purely so the Trips list can sort/filter by
  date without joining to `travellog_stops` on every query; there is no
  "trip settings" form field for these.
- **Trip status is computed, never stored** (`T.11`): `planning` if the
  trip has zero stops; otherwise `upcoming` / `ongoing` / `completed` from
  today's date against the derived `[start_date, end_date]`. See
  CONCEPT.md's open question 3 for the alternative (an explicit,
  user-set status) this deliberately doesn't build yet.
- **`travellog_stops.position`** is fractional (same midpoint-insertion
  pattern as `sovereign-plugin-kanban`'s `_db/position.ts`), independent of
  `arrive_date`/`depart_date` — a stop can be reordered before its dates
  are finalized. The UI should nudge these to stay consistent but this
  isn't a DB constraint.
- **`travellog_trip_days` is keyed by `stop_id`, not directly by trip.**
  Editing a stop's date range auto-generates/removes `trip_day` rows to
  match; removing a day that still has `itinerary_item` rows must prompt
  the user rather than silently cascading (unlike every other cascade-
  delete in this schema — call this out specifically in `T.11`'s tests).
- **`itinerary_items.is_fixed`** is only meaningful alongside a
  `planned_time` — the Planner UI (`T.16`) should require a time before
  allowing the fixed toggle, not enforce it at the DB layer.
- **`visits.external_ref`** is how the Swarm importer (and, later, any
  other importer) avoids creating duplicate visits on a re-run — unique per
  `(tenant_id, source, external_ref)`.
- **Auto-link algorithm:** on visit create/import, compare the visit's
  **local calendar date** (derived from `happened_at` + `tz_iana`, not the
  raw UTC instant) against each of the user's trips' derived `[start_date,
end_date]` range. A single matching trip → propose it, `link_source:
  'auto'`. Multiple matching trips (e.g. a work trip and a personal weekend
  sharing dates) → propose the trip with the **narrower date range**, still
  `link_source: 'auto'`, never left ambiguous when at least one candidate
  exists. The user can always override; overriding sets `link_source:
  'manual'`, and no later recompute touches a `manual` row. **Not
  addressed in phase 1:** geography-assisted disambiguation, and any
  "confirm once, then it learns" behavior.
- **Place provider interface** (CONCEPT.md open question 1 — the adapter
  choice is still open, the interface shape isn't):

  ```ts
  interface PlaceCandidate {
    name: string;
    lat: number | null;
    lng: number | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    countryCode?: string | null;
    postalCode?: string | null;
    category?: string | null;
    sourceRef?: string | null;
    /**
     * Set only when this candidate IS an existing `travellog_places` row
     * (found by the manual provider's own search) — the caller reuses this
     * place directly instead of calling `createPlace()`, which would
     * otherwise mint a duplicate row for a place that already exists.
     * Undefined for a candidate from an external provider (`T.3a`'s OSM
     * adapter) that has never been created locally. **Added while
     * implementing `T.3`** — the first draft of this interface had no way
     * to distinguish "select this existing place" from "materialize a new
     * one from this candidate," which would have silently duplicated a
     * place every time someone re-selected it from their own search
     * history.
     */
    existingPlaceId?: string;
  }

  interface PlaceProvider {
    search(query: string, near?: { lat: number; lng: number }): Promise<PlaceCandidate[]>;
    reverseGeocode(lat: number, lng: number): Promise<PlaceCandidate | null>;
  }
  ```

  `createPlace()` (`app/_lib/places.ts`) — the actual local insert — is
  **deliberately not part of the `PlaceProvider` interface**: every place a
  visit or itinerary item ends up referencing must exist as a real
  `travellog_places` row regardless of which provider found it, but an
  external provider only ever *finds* candidates, it doesn't own creating
  local rows for them. `getPlaceProvider(db, ctx)` — the factory —
  takes the DB client and `{ tenantId }` and returns a provider bound to
  that context; the `PlaceProvider` interface's own methods stay
  context-free by design; a provider's constructor is where per-call
  scoping gets closed over.

  Phase 1 ships a **manual provider** (`T.3`): `search()` matches against
  the tenant's own previously-created `travellog_places` rows (any
  `source`, not just prior manual entries — an imported Swarm place must be
  just as findable) plus always offering "create new place" with a
  free-text name and an optional map-pick coordinate; `reverseGeocode()`
  returns `null`. No external dependency, no network call. An OSM-backed
  provider (`T.3a`) is a fast-follow, not a blocker.

---

## Data fetching contract

Organized per screen, matching CONCEPT.md's "Web UI" structure. Server
components fetch; `loading.tsx` per route segment gates rendering.
Mutations are server actions returning the platform `ActionResult` shape,
consumed via `useActionState` (`sv-ui-design` skill's error convention).

**Trips (`T.13`/`T.14`)**

1. *Overview payload* — trip counts by computed status, unique place count,
   unique country count, total check-in count, next-upcoming-trip summary.
   All aggregated server-side (`GROUP BY`/`COUNT DISTINCT`), never computed
   by fetching every row to the client.
2. *Card list payload* — paged, grouped by computed status then sorted by
   date within each group: trip id, name, derived date range, day count
   (from stop count → day count), a destination summary (first + count of
   additional stops), member avatars.
3. *Detail-column payload* (on card click) — trip meta + member list (id,
   name, avatar, role). Deliberately thin — no itinerary detail, per the
   deferred single-page trip view.

**Check-ins (`T.6`)**

4. *Timeline payload* — paged, reverse-chronological, grouped by day: visit
   id, place (name, category), `happened_at`, note excerpt, first photo
   thumbnail, trip name badge if linked.
5. *Detail-column payload* (on item click) — full visit: photos, note,
   companions, trip link with an unlink action.

**Planner (`T.15`/`T.16`)**

6. *Trip picker payload* — trips scoped to `planning`/`upcoming` status:
   id, name, status, stop count.
7. *Workspace payload* (trip selected) — ordered stops (id, place,
   arrive/depart dates), and for whichever stop is currently selected in
   the strip, its days with nested itinerary items in `position` order.
8. *Item detail-column payload* (on item click) — single itinerary item's
   full edit fields (place, planned time, `is_fixed`, notes).

## Import design

Two genuinely separate import paths — do not conflate them:

- **Swarm importer** (`T.8`) — triggered from the **Check-ins** screen (a
  file-upload action, not tied to live check-in capture), parsing a
  third-party export format into `travellog_*` rows. Designed **resumable
  from the start**: the ZIP's check-ins import fast (one pass, de-duplicated
  via `external_ref`), but photos are URLs that must be individually
  fetched, rate-limited, and can partially fail — that work runs as an
  `sdk.jobs` background job (`type: 'import.swarm'`), with
  `travellog_import_jobs` tracking a domain-specific resume cursor (which
  check-in the photo-fetch loop is currently on) that the platform's
  generic `JobRef` status doesn't carry. A failed/interrupted job resumes
  from its cursor, not from scratch.
- **Sovereign portability hooks** (`T.23`) — `sdk.portability.provideExport`
  / `provideImport`, for the platform's own takeout/instance-migration
  format. This exists **in addition to** the Swarm importer, serves a
  different purpose (moving a user's Travellog data between Sovereign
  instances, or into a full-instance backup), and uses the platform's own
  bundle format, not Swarm's.

## Routes

```
/travellog                        Redirect → /travellog/checkins           [web]  (→ /travellog/trips once T.13 ships Trips for real — T.9 found live that redirecting to Trips' placeholder today undercuts Slice 1's "ships standalone and useful")
/travellog/trips                  Trips (overview stats + cards)           [web]
/travellog/checkins               Check-ins timeline                       [web]
/travellog/checkins/import        Swarm import flow                        [web]
/travellog/planner                Planner (trip picker)                    [web]
/travellog/planner/[tripId]       Planner workspace (stops + day editor)   [web]
/travellog/planner/[tripId]/mode  Trip Mode (day navigation)                [mobile only — Slice 3, deferred UI design]
/travellog/settings               Settings (placeholder — no real content scoped yet) [web]
```

Trip/item detail is a **third-column state**, not a route — clicking a card
or item sets local component state (matching `ThreeColumnLayout`'s
`ConditionalDetail` pattern), not a navigation. Mobile routes are
intentionally unlisted — not yet designed.

## UI composition (Design System)

| Need                      | DS surface                                                   |
| -------------------------- | -------------------------------------------------------------- |
| Whole-app shell             | `ThreeColumnLayout` — see "Web navigation & layout"            |
| Sidebar nav                 | Plugin-local `TravellogSidebar`, direct copy of `sovereign-plugin-docs`'s `DocsSidebar` structure |
| Page chrome (within a column) | `PageContainer`, `PageHeader`                                |
| Create/confirm dialogs      | `Dialog` (`md`)                                                |
| Trip sharing                | Plugin-local `TripShareButton`/`TripShareDialog`, direct copy of `sovereign-plugin-docs`'s `FolderShareButton`/`FolderShareDialog` pattern (`sdk.directory` search) |
| Menus (stop/day/item)       | `Menu` / `MenuEntries`                                        |
| Quick-entry (note, search)  | `Input` + `useCommitOnEnterOrBlur`                             |
| Status badges/chips         | `Badge`                                                         |
| Confirmation                | `ConfirmDialog`                                                 |
| Empty / loading             | `EmptyState`, `Spinner`, skeletons per DS patterns             |
| Toasts                      | `useToast`                                                      |
| Map                        | **Not in `packages/ui` today.** Deferred past this web-first pass — Check-ins' map view and any future Planner map are noted but not scoped into a task yet. |

---

## Tasks

Task IDs `T.<seq>` are stable identifiers. One task = one branch = one PR.
Sequenced unless tagged `[parallel]`. Every PR bumps `manifest.json`'s
version per the change (never `package.json`).

Common review checklist (implied for every task, in addition to each task's
own): `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` and
`pnpm design:tokens:check` pass; no `runtime/src` imports; user-facing copy
says "app/trip/stop/check-in/place", never "plugin".

---

### Slice 1 — Check-in foundation, web shell, Swarm import

#### T.1 — Plugin scaffold & manifest

**Goal:** A composed, routable plugin skeleton with the decided manifest.

**Deliverables:**

- Scaffold via `sv plugin new` conventions: `manifest.json` (id
  `fs.sovereign.travellog`, routePrefix `/travellog`, **`shell: "minimal"`**
  — see "Plugin identity" for why this changed from the first draft's
  `"default"` — permissions `auth:session`, `db:readWrite`,
  `storage:readWrite`, `notifications:send`, `jobs:write`, `data:export`,
  `data:import`), `package.json` pinned `0.0.0`, `app/` with a placeholder
  page.
- Plugin icon per the icon system.
- Composes under `pnpm dev`; tile appears in Launcher.

**Dependencies:** none.

**Review checklist:** plugin loads at `/travellog` in dev; manifest
validates (`pnpm generate` clean); no platform header/footer renders (since
`shell: "minimal"`).

---

#### T.2 — Slice 1 data model & migrations

**Goal:** `travellog_places`, `travellog_visits`, `travellog_visit_photos`
migrated and queryable.

**Deliverables:**

- Drizzle schema for the three tables per the Data model section, including
  indexes: `travellog_visits(user_id, happened_at)`,
  `travellog_visits(place_id)`, `travellog_visits(tenant_id, source,
external_ref)` unique, `travellog_places(tenant_id, name)`.
- Generated migrations.
- Seed helper for dev (a handful of demo places/visits).

**Dependencies:** T.1.

**Review checklist:** migrations run clean on a fresh dev DB; unique
constraint on `(tenant_id, source, external_ref)` rejects a duplicate
insert.

---

#### T.3 — Place provider interface & manual-first implementation

**Goal:** Check-in and trip planning can search/create places with zero
external dependencies.

**Deliverables:**

- `PlaceProvider` interface per the Data model section.
- Manual provider: search against the tenant's existing places; "create new
  place" flow (name + optional map-pick coordinates via a plain click-to-set
  map, not search).
- Provider is swappable behind one factory function — no call site imports a
  concrete provider directly.

**Dependencies:** T.2.

**Review checklist:** searching an unmatched name always offers "create
new"; creating a place with no coordinates is allowed and doesn't break
downstream rendering (it just doesn't get a pin, once a map exists).

---

#### T.3a — OSM place-search adapter `[parallel with T.4+]`

**Goal:** A real search experience, without committing to a paid provider.

**Deliverables:**

- Nominatim-backed `search()`/`reverseGeocode()` implementation of
  `PlaceProvider`.
- Operator-configurable base URL (self-hosted Nominatim/Photon instance
  overridable via env var — do not hardcode the public Nominatim endpoint as
  the only option), with client-side rate-limiting and result caching as
  polite defaults against the public instance when no override is set.
- Falls back to the manual provider's "create new place" path when a search
  returns nothing.

**Dependencies:** T.3. Does not block T.4 onward — the manual provider is
sufficient for Slice 1 to keep moving; this can land whenever the place/map
provider question (CONCEPT.md open question 1) is actually settled.

**Review checklist:** search against a self-hosted or public Nominatim
returns real results; hitting the provider's rate limit degrades to the
manual provider without erroring the whole check-in flow.

---

#### T.4 — Server data layer & actions: check-in

**Goal:** The query + mutation layer Slice 1's surfaces build on.

**Deliverables:**

- Query modules for the check-ins timeline payload (Data fetching
  contract).
- Server actions: create visit (manual/GPS), edit visit, delete visit, place
  search/create — each starting with `sdk.auth.requireSession()`, scoped to
  the calling user, returning `ActionResult`.
- Timezone handling: every visit stores UTC + IANA zone + local offset,
  derived from the client's `Intl.DateTimeFormat().resolvedOptions().timeZone`
  at check-in time (not guessed server-side).

**Dependencies:** T.3.

**Review checklist:** a visit created at a given local time round-trips to
the same local time when read back; reading someone else's visit is
impossible (ownership-scoped, not just tenant-scoped — see "Hard platform
rules").

---

#### T.5 — Web shell: sidebar nav & `ThreeColumnLayout` scaffold

**Goal:** The persistent web shell every other web task builds inside.

**Deliverables:**

- `app/(home)/layout.tsx` wrapping `ThreeColumnLayout`, direct structural
  copy of `sovereign-plugin-docs`'s equivalent file.
- `TravellogSidebar`: Trips/Check-ins/Planner links, divider, bottom section
  (Settings), direct copy of `DocsSidebar.tsx`'s structure and active-link
  logic. **Corrected during implementation**: no Launcher link in the
  sidebar itself, unlike this task's first-draft text above — see the
  Status section's `T.5` entry for why (both `sovereign-plugin-docs` and
  `sovereign-plugin-kanban` have since moved that affordance to a
  root-level header instead, and this plugin follows their current, real
  pattern, not their older one).
- **Also added, beyond this task's original text**: a root `app/layout.tsx`
  with a minimal `TravellogHeader` (the actual way back to Launcher —
  without it, nothing provided one at all). Right-side chrome (apps
  switcher, account menu) is real, tracked, deferred scope — see `T.5a`.
- Placeholder pages for `/travellog/trips`, `/travellog/checkins`,
  `/travellog/planner`, `/travellog/settings` (empty states — real content
  is `T.6`/`T.13`/`T.15` onward); root `/travellog` redirects to
  `/travellog/trips`.

**Dependencies:** T.1.

**Review checklist:** sidebar stays mounted (no flash/refetch) navigating
between the four sections, matching Docs' own documented rationale for why
this layout shape avoids that; active-link styling matches the current
route.

---

#### T.5a — App switcher & account menu chrome `[parallel with T.6+]`

**Goal:** Complete the root header's right side, deferred out of `T.5`.

**Deliverables:**

- An apps-switcher popover — direct copy of `sovereign-plugin-docs`'s/
  `sovereign-plugin-kanban`'s `AppsMenu.tsx` (identical between the two),
  admin-capability-gated Console tile included.
- An account menu — direct copy of `DocsAccountMenu`/`KanbanAccountMenu`
  (also identical between the two): avatar, name, sign-out.
- Wire both into `TravellogHeader`'s right side; the component likely needs
  `'use client'` at that point (see `TravellogHeader`'s own doc comment).

**Dependencies:** T.5. Non-blocking — doesn't block any Slice 1/2 UI task;
land whenever convenient.

**Review checklist:** the apps popover lists installed apps and correctly
hides the Console tile for a non-admin; the account menu shows the actual
signed-in user and sign-out works.

---

#### T.6 — Check-ins screen (web): timeline & detail

**Goal:** The visit log, view-only, as a read-side projection.

**Deliverables:**

- Reverse-chronological, day-grouped timeline (Data fetching contract
  payload 4) with `loading.tsx` gate and `EmptyState`.
- Click a visit → detail column (payload 5): photos, note, companions, trip
  link + unlink.
- No check-in creation here — web is view-only (see `T.7`).

**Dependencies:** T.4, T.5.

**Review checklist:** wireframe-first per `sv-ui-design`; detail column
opens via `ThreeColumnLayout`'s conditional-child pattern (verify no route
change occurs on selection); empty state has no dead-end (points at import,
`T.8`, since web can't create a check-in directly).

---

#### T.7 — Check-in creation (mobile)

**Goal:** The three check-in paths from CONCEPT.md, mobile-only.

**Deliverables:**

- Search-first flow: type a place name → provider results → select →
  confirm dialog with optional note/photo.
- `useCurrentPosition()` hook wrapping `navigator.geolocation` (see
  "Location source") for "check in here"; graceful denial/unavailable state
  (never blocks manual entry).
- Photo attach via `sdk.storage` on confirm.
- **Web has no equivalent entry point** — this task's actual screen
  placement/layout is deferred pending the mobile UI concept-review pass
  CONCEPT.md notes hasn't happened yet; build the server-action-consuming
  logic now, finalize the screen once that pass happens.

**Dependencies:** T.4.

**Review checklist:** check-in with no location permission granted still
completes via search/manual; quick-entry note field commits on Enter and
blur.

---

#### T.8 — Swarm importer

**Goal:** A resumable importer that turns a real Swarm export ZIP into
`travellog_places`/`visits`/`visit_photos` rows, triggered from the
Check-ins screen.

**Deliverables:**

- `/travellog/checkins/import` flow: ZIP upload → parse `checkins.json` (+
  `photos.json` if photos are a separate file in the real export — **verify
  the actual field names and file layout against a real Swarm export
  before finalizing the mapping**; CONCEPT.md open question 5 is still
  unresolved as of this spec, the field list here is inferred from
  third-party tooling, not confirmed).
- `sdk.jobs`-backed background job (`type: 'import.swarm'`) doing the actual
  work; `travellog_import_jobs` row tracks progress and a resume cursor.
- Photo fetch: rate-limited, retried on transient failure, each success
  written to `sdk.storage` and linked via `travellog_visit_photos`; a
  failed photo doesn't fail the whole check-in's import (log it, continue).
- Import status UI: progress, resumable if interrupted, a completion
  notification via `sdk.notifications.send()`.
- De-dup via `visits.external_ref` — safe to re-run the same export.

**Dependencies:** T.4, T.5. **Blocked on obtaining and inspecting a real
Swarm export before the field-mapping code is finalized** — build the job
scaffolding and resume/retry machinery against the inferred shape, but treat
the exact field mapping as the last thing locked, not the first.

**Review checklist:** interrupting the job mid-run (kill the process) and
restarting resumes from the cursor, not from zero; re-running an already-
completed import creates no duplicate rows; a photo URL that 404s doesn't
abort the job.

---

#### T.9 — Slice 1 hardening & polish pass

**Goal:** Ship-ready Slice 1 (web).

**Deliverables:**

- Full pass against CONCEPT.md's Slice 1 + Web UI sections; fix gaps found
  live.
- Loading/empty/error states audited on every Slice 1 web surface.
- `SPEC.md` Status section gets a real entry (this file's own convention,
  see `sovereign-plugin-kanban/SPEC.md`'s Status section for the expected
  level of detail — narrative, not just a checkbox).

**Dependencies:** T.6, T.7, T.8.

**Review checklist:** a fresh user can browse their log, check in from
mobile, and import a real Swarm export with no dead ends.

---

### Slice 2 — Trips, Planner, stops, auto-link

#### T.10 — Trip/stop/itinerary data model & migrations

**Goal:** `travellog_trips`, `travellog_stops`, `travellog_trip_days`,
`travellog_itinerary_items`, `travellog_attachments` migrated; `visits`
gains its (already-defined in T.2) `trip_id`/`link_source` columns
activated. `travellog_trip_members` included **only if CONCEPT.md open
question 2 has been confirmed** as real shared access by the time this
task starts — otherwise substitute a plain nullable text field on
`travellog_trips` for companion-style tags instead, and update `T.14`
accordingly.

**Deliverables:**

- Drizzle schema for the tables per the Data model section, with indexes:
  `travellog_trips(owner_id, start_date)`, `travellog_stops(trip_id,
position)`, `travellog_trip_days(stop_id, date)` unique,
  `travellog_itinerary_items(trip_day_id, position)`,
  `travellog_attachments(trip_id)`, `travellog_attachments(trip_day_id)`.
- Migration.

**Dependencies:** T.2.

**Review checklist:** migrations run clean; app-layer check enforces
exactly one of `attachments.trip_id`/`trip_day_id` set (covered by a unit
test, not just a comment).

---

#### T.11 — Trip, stop & itinerary server layer & actions

**Goal:** CRUD and reorder for trips, stops, days, and itinerary items, plus
the derived status/date-range computation.

**Deliverables:**

- Trip CRUD (create just takes a name — no date range field, see Data
  model notes).
- Stop CRUD + reorder (fractional `position`, same pattern as
  `sovereign-plugin-kanban`'s `_db/position.ts`); adding/editing a stop's
  dates recomputes the trip's denormalized `start_date`/`end_date` in the
  same transaction, and auto-generates/removes `travellog_trip_days` rows
  to match (blocking removal of a day that still has itinerary items —
  prompt instead of cascading).
- Trip status resolver: `planning`/`upcoming`/`ongoing`/`completed` from
  stop presence + derived dates (Data model notes) — a pure function,
  reused by every screen that needs it, not recomputed ad hoc per surface.
- Itinerary item CRUD + reorder, including the `is_fixed` toggle (only
  settable alongside a `planned_time`).
- Attachment upload/delete via `sdk.storage`, tied to a trip or a specific
  day.
- Trip sharing actions (`T.14`'s server half, if `travellog_trip_members`
  exists per this task's own conditional scope): add/remove member by
  `sdk.directory` user id, owner-only.
- Authorization: every action scoped to the trip's owner, or (if sharing
  exists) any member with the appropriate role.

**Dependencies:** T.10.

**Review checklist:** creating a 5-day stop produces 5 `trip_day` rows with
correct dates across a DST transition (test this explicitly — timezone bugs
are the class of bug this plugin is most exposed to); removing a stop's
last day while it still has itinerary items is blocked, not silently
cascaded; status resolver unit-tested across all four states plus the
boundary transitions.

---

#### T.12 — Auto-link engine

**Goal:** The date-window auto-link from the Data model section, working on
both new check-ins and existing history, against the now stop-derived trip
date range.

**Deliverables:**

- Auto-link runs synchronously on visit create/import (T.4/T.8's write
  paths call into it).
- A "recompute auto-links" action for when a trip's stops change after
  visits already exist — re-derives every `link_source: 'auto'` visit's
  `trip_id`, **never touches a `link_source: 'manual'` row**.
- Manual override server action (the UI hook point is `T.6`'s detail
  column).

**Dependencies:** T.11, T.4.

**Review checklist:** unit tests cover the narrower-range-wins rule from the
Data model section's auto-link algorithm note; a manually-overridden link
survives a recompute; a visit outside every trip's window gets `trip_id:
null`, not an error.

---

#### T.13 — Trips screen (web): overview & cards

**Goal:** The Trips browse/manage hub per CONCEPT.md's "Web UI" section.

**Deliverables:**

- Overview stat block (payload 1): trip counts, unique places, unique
  countries, total check-ins, next-trip highlight.
- Status-grouped, date-sorted trip cards (payload 2) with the per-status
  CTA (Continue planning / View itinerary / Open Trip Mode / View trip).
- Status-chip + name-search filtering.
- "Create trip" CTA → modal (name only — stops get added in Planner).

**Dependencies:** T.11, T.5.

**Review checklist:** wireframe-first per `sv-ui-design`; card grouping and
CTA both reflect the computed status correctly across all four states;
creating a trip from here lands the user in Planner for it.

---

#### T.14 — Trips screen: trip detail panel & sharing

**Goal:** The detail-column experience on card click.

**Deliverables:**

- Detail column (payload 3): basic trip metadata — intentionally not a
  full trip-details page (deferred per CONCEPT.md).
- **If `travellog_trip_members` exists** (per `T.10`'s conditional scope):
  `TripShareButton`/`TripShareDialog`, direct copy of
  `sovereign-plugin-docs`'s `FolderShareButton`/`FolderShareDialog` —
  `sdk.directory` search, add/remove member, owner-only.
- **If it doesn't** (companion-tags alternative instead): a plain free-text
  field on the trip, no access-control implications, no directory search.

**Dependencies:** T.13, T.11.

**Review checklist:** clicking a card opens the detail column via
`ThreeColumnLayout`'s conditional child, no route change; if sharing is
real access — an added member can actually open the trip afterward
(end-to-end, not just that the row exists); a non-member cannot.

---

#### T.15 — Planner: trip picker & stop workspace

**Goal:** The Planner entry screen and its stop-timeline-strip workspace.

**Deliverables:**

- No-trip-selected state: picker scoped to `planning`/`upcoming` trips
  (payload 6) + "New trip" CTA (same modal as `T.13`'s).
- Trip-selected state: stop timeline strip (payload 7's stop list) —
  ordered, reorderable, "Add a stop" (place via `T.3`'s provider + arrival/
  departure dates), selecting a stop determines which stop's days render
  below (local state, no navigation).

**Dependencies:** T.11, T.3.

**Review checklist:** wireframe-first per `sv-ui-design`; adding a first
stop to a brand-new trip correctly flips its computed status out of
`planning` (or doesn't, if open question 3 resolves the other way by the
time this ships — check `CONCEPT.md` before assuming); stop reorder uses
the same drag pattern precedent as `sovereign-plugin-kanban`'s K.7 (web
`PointerSensor`, distance-activated, no handles).

---

#### T.16 — Planner: day-by-day itinerary editor

**Goal:** The day list + itinerary items for whichever stop is selected in
`T.15`'s strip.

**Deliverables:**

- Days (auto-generated from the selected stop's date range) each listing
  itinerary items in `position` order: place (via `T.3`'s provider, or a
  free-text title with no place), planned time, notes, reorderable.
- Adding/editing a timed item offers the **fixed vs. flexible** toggle
  (only enabled once a time is set).
- Clicking an item opens the detail column (payload 8) for its edit view.

**Dependencies:** T.15, T.11.

**Review checklist:** reorder within a day writes exactly one row per drop;
marking an item fixed without a planned time is prevented in the UI (not
just silently ignored); switching the selected stop in the strip correctly
swaps the day list with no stale data flash.

---

#### T.17 — Slice 2 hardening & polish pass (web)

**Goal:** Ship-ready Slice 2, web only.

**Deliverables:**

- Full pass against CONCEPT.md's Slice 2 + Web UI (Trips/Planner) sections;
  fix gaps found live.
- `SPEC.md` Status section entry.
- Explicitly **not** in this pass, per CONCEPT.md's "Deferred, not yet
  planned": mobile UI, the full single-page trip-details view, and the
  richer "planned vs. actual" comparison view that depends on it.

**Dependencies:** T.13, T.14, T.15, T.16.

**Review checklist:** a fresh user can create a trip from Trips or Planner,
build out its stops and day-by-day itinerary, and have unrelated check-ins
during it auto-link correctly — all on web.

---

### Slice 3 — Trip Mode (day navigation)

#### T.18 — Trip Mode data & logic

**Goal:** The server-side "what does today look like right now" query.

**Deliverables:**

- Given a stop's day and the current instant, resolve: today's planned
  itinerary items in order, which one is "next" (first with a planned time
  after now), and a countdown value.
- Handles items with no planned time (render in position order, un-timed)
  and a day with zero planned items (empty state, not an error).
- **No route-order changes here** — this resolves the plan exactly as
  manually ordered. Proximity/routing-aware resequencing is explicitly
  deferred (see CONCEPT.md's "Future (deferred)" section) and is not part
  of this task's scope.

**Dependencies:** T.11.

**Review checklist:** unit tests cover a trip that crosses a date line and
a day boundary edge case (11:59pm → 12:01am local) without misattributing
"today."

---

#### T.19 — Trip Mode UI (mobile-first) & maps hand-off

**Goal:** The actual Trip Mode screen, entered via "Start" on a stop's day
view.

**Deliverables:**

- `/travellog/planner/[tripId]/mode`, active only within the trip's real
  date range (redirect/empty-state outside it).
- Today's schedule, current position (via `T.7`'s `useCurrentPosition`),
  next stop + countdown, hand-off link to the device's native maps app
  (pick one deep-link convention — platform `maps:`/`geo:` URI scheme or a
  plain `https://maps.google`/`https://maps.apple` fallback — and document
  it, don't build three).
- Quick check-in shortcut from within Trip Mode (reuses `T.7`).
- **This screen's exact layout is part of the mobile UI pass CONCEPT.md
  notes hasn't happened yet** — build the "Start" entry point and the data
  wiring now; finalize visual design once that pass happens.

**Dependencies:** T.18, T.7.

**Review checklist:** maps hand-off opens the device's actual maps app on a
real iOS Simulator, not just a new browser tab.

---

#### T.20 — Notification reminders

**Goal:** "Your next stop is in 20 minutes."

**Deliverables:**

- `sdk.notifications.send()` wired to `T.18`'s "next stop" resolution,
  fired at a configurable lead time before the planned time.
- Respects the item having no planned time (no reminder possible — don't
  send a meaningless one).

**Dependencies:** T.18.

**Review checklist:** a reminder fires once per item, not repeatedly; no
reminder for un-timed items.

---

#### T.21 — Offline capability wiring

**Goal:** Trip Mode and check-in work in a dead zone.

**Deliverables:**

- Manifest gains `offline: 'offline-first'` (see "Offline posture" above —
  **re-verify the current client-side replica/sync API against workstream
  0008's actual state before implementing**, and re-check whether the bare
  route's redirect to `/travellog/trips` still satisfies the offline
  entry-point contract).
- Client-side cache of the active trip's itinerary and recent places, kept
  fresh in the background.
- Offline check-in queues locally and syncs on reconnect.

**Dependencies:** T.19, and platform workstream 0008's offline-first
mechanics being in a usable state — **check current platform status before
starting**, this is the one task in this spec with a real external
dependency risk.

**Review checklist:** airplane-mode check-in during an active trip syncs
correctly once connectivity returns; the itinerary is readable offline.

---

#### T.22 — Slice 3 hardening & release pass

**Goal:** Ship-ready Slice 3 — the full phase 1 concept complete (web
Trips/Check-ins/Planner + mobile check-in/Trip Mode data layer; mobile
*screens* remain deferred per CONCEPT.md).

**Deliverables:**

- Full pass against CONCEPT.md's Slice 3 description; fix gaps found live.
- End-to-end pass across all three slices together (a real trip, planned in
  advance on web, lived through with Trip Mode, with unplanned check-ins
  mixed in).
- `SPEC.md` Status section entry; `ROADMAP.md` marked complete through
  phase 1.

**Dependencies:** T.19, T.20, T.21.

**Review checklist:** the full CONCEPT.md walkthrough (check in anywhere →
builds history → import populates it → plan a trip with stops on web →
live it via Trip Mode on mobile → auto-link → status transitions correctly)
works end to end on one real account.

---

### Portability & deferred

#### T.23 — Sovereign portability hooks (export/import/delete)

**Goal:** Standard platform takeout support, per RFC 0007/0052 — additional
to, not a replacement for, the Swarm importer (see "Import design").

**Deliverables:**

- `sdk.portability.provideExport` covering every `travellog_*` table plus
  storage object references (photos, attachments).
- `provideImport` remapping ids/storage references on restore.
- Deletion hook removing all Travellog-owned rows and storage objects for a
  deleted user, idempotently — including their trip memberships (if
  `travellog_trip_members` exists) without deleting a shared trip out from
  under its other members.

**Dependencies:** T.22 (needs the full phase 1 schema stable).

**Review checklist:** export → delete all local data → import round-trips
to an identical visit/trip history, including photos; deleting one member
of a shared trip leaves the trip and its other members intact.

---

#### T.24 — App-level field encryption for `visit.note` (RFC 0092) `[optional, deferred]`

**Goal:** Let an operator who enables `SOVEREIGN_ENCRYPT_CLASSES` protect
free-text check-in notes at the field level — addresses the research doc's
sensitivity concern for the one column phase 1 leaves genuinely exposed
beyond disk/volume encryption (see "Encryption posture").

**Deliverables:**

- `visit.note` reclassified via `encryptedText('note', { sensitivity:
'sensitive' })`.
- `crypto:use` permission added to the manifest.
- Docs note for operators: what gets protected (just the note text) and
  what doesn't (coordinates, timestamps, place names — required for
  the map/auto-link to function).

**Dependencies:** T.22. Not required for phase 1 to ship — track
separately, pick up if/when an operator or reviewer actually asks for it.

**Review checklist:** with `SOVEREIGN_ENCRYPT_CLASSES=sensitive` set, a
note is ciphertext at rest (verify by querying the DB directly, not just
through the app); with it unset, behavior is unchanged from `T.4`.

---

## Related

- Product concept: [CONCEPT.md](CONCEPT.md), including "Future (deferred):
  trip navigation & route optimization" — the Phase 2a/2b proximity- and
  routing-aware Trip Mode enhancement this spec deliberately does not task
  out yet, and "Deferred, not yet planned" — mobile UI and the full trip
  details page.
- Platform research: `docs/research/0005-trip-planning-and-place-checkin-plugin.md`
  (in the `sovereignfs/sovereignfs` platform repo).
- [ROADMAP.md](ROADMAP.md) — prioritized build order.
