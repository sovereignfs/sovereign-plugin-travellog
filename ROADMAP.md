# Sovereign Travellog — Roadmap

**Manifest version:** 0.27.0 · **Last updated:** 2026-08-29

Chronological build index — one row per PR, platform-`ROADMAP.md` style. Full
task detail lives in [SPEC.md](SPEC.md); the product concept in
[CONCEPT.md](CONCEPT.md).

Slot versions are the plugin's **`manifest.json`** version after that task
lands (the plugin's `package.json` stays pinned at `0.0.0` — platform
convention). Slots are volatile ordering; task IDs (`T.<seq>`) are the stable
identifiers. Each task = one branch = one PR = one review gate; tasks depend
on the previous row unless noted.

This is the fourth pass over this file. The third pass: `T.5`'s
implementation surfaced a real gap (nothing provided a way back to
Launcher) and added `T.5a` to close it, shifting every slot after `T.5`
down by one — see `SPEC.md`'s `T.5` status entry for that account. This
(fourth) pass: `T.5a` itself finally shipped, but not at its
originally-reserved `0.7.0` slot — every task from `T.6` through `T.24`
landed in strict sequence while `T.5a` sat deferred (`[parallel]`, blocking
nothing), so `0.7.0` was never actually tagged in `manifest.json`'s real
history. Its row moved out of Phase 1a (where it was reserved) down into
Phase 1d at `0.27.0`, its real landing slot — leaving a stale `0.7.0`
reference anywhere would point at a version that was never shipped.

## Phase 1a — Check-in foundation & web shell (Slice 1)

| Slot   | Task                                              | Status | Spec task                                                                     |
| ------ | --------------------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| 0.1.0  | Plugin scaffold & manifest                        | ✅     | [T.1](SPEC.md#t1--plugin-scaffold--manifest)                                     |
| 0.2.0  | Slice 1 data model & migrations                   | ✅     | [T.2](SPEC.md#t2--slice-1-data-model--migrations)                                |
| 0.3.0  | Place provider interface & manual-first implementation | ✅ | [T.3](SPEC.md#t3--place-provider-interface--manual-first-implementation)         |
| 0.4.0  | OSM place-search adapter `[parallel]`             | ✅     | [T.3a](SPEC.md#t3a--osm-place-search-adapter-parallel-with-t4)                   |
| 0.5.0  | Server data layer & actions: check-in             | ✅     | [T.4](SPEC.md#t4--server-data-layer--actions-check-in)                           |
| 0.6.0  | Web shell: sidebar nav & `ThreeColumnLayout` scaffold | ✅ | [T.5](SPEC.md#t5--web-shell-sidebar-nav--threecolumnlayout-scaffold)             |
| 0.8.0  | Check-ins screen (web): timeline & detail         | ✅     | [T.6](SPEC.md#t6--check-ins-screen-web-timeline--detail)                         |
| 0.9.0  | Check-in creation (mobile)                        | ✅     | [T.7](SPEC.md#t7--check-in-creation-mobile)                                      |
| 0.10.0 | Swarm importer                                    | ✅     | [T.8](SPEC.md#t8--swarm-importer)                                                |
| 0.11.0 | Slice 1 hardening & polish pass                   | ✅     | [T.9](SPEC.md#t9--slice-1-hardening--polish-pass)                                |

## Phase 1b — Trips & Planner (Slice 2)

| Slot   | Task                                                | Status | Spec task                                                                     |
| ------ | ----------------------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| 0.12.0 | Trip/stop/itinerary data model & migrations         | ✅     | [T.10](SPEC.md#t10--tripstopitinerary-data-model--migrations)                    |
| 0.13.0 | Trip, stop & itinerary server layer & actions       | ✅     | [T.11](SPEC.md#t11--trip-stop--itinerary-server-layer--actions)                  |
| 0.14.0 | Auto-link engine                                    | ✅     | [T.12](SPEC.md#t12--auto-link-engine)                                            |
| 0.15.0 | Trips screen (web): overview & cards                | ✅     | [T.13](SPEC.md#t13--trips-screen-web-overview--cards)                            |
| 0.16.0 | Trips screen: trip detail panel & sharing           | ✅     | [T.14](SPEC.md#t14--trips-screen-trip-detail-panel--sharing)                     |
| 0.17.0 | Planner: trip picker & stop workspace               | ✅     | [T.15](SPEC.md#t15--planner-trip-picker--stop-workspace)                         |
| 0.18.0 | Planner: day-by-day itinerary editor                | ✅     | [T.16](SPEC.md#t16--planner-day-by-day-itinerary-editor)                         |
| 0.19.0 | Slice 2 hardening & polish pass (web)               | ✅     | [T.17](SPEC.md#t17--slice-2-hardening--polish-pass-web)                          |

## Phase 1c — Trip Mode (Slice 3)

| Slot   | Task                                          | Status | Spec task                                                                     |
| ------ | ------------------------------------------------ | ------ | --------------------------------------------------------------------------------- |
| 0.20.0 | Trip Mode data & logic                        | ✅     | [T.18](SPEC.md#t18--trip-mode-data--logic)                                       |
| 0.21.0 | Trip Mode UI (mobile-first) & maps hand-off   | ✅     | [T.19](SPEC.md#t19--trip-mode-ui-mobile-first--maps-hand-off)                    |
| 0.22.0 | Notification reminders                        | ✅     | [T.20](SPEC.md#t20--notification-reminders)                                      |
| 0.23.0 | Offline capability wiring                     | ✅     | [T.21](SPEC.md#t21--offline-capability-wiring)                                   |
| 0.24.0 | Slice 3 hardening & release pass              | ✅     | [T.22](SPEC.md#t22--slice-3-hardening--release-pass)                             |

## Phase 1d — Portability & deferred

| Slot   | Task                                                          | Status | Spec task                                                                                          |
| ------ | ---------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| 0.25.0 | Sovereign portability hooks (export/import/delete)            | ✅     | [T.23](SPEC.md#t23--sovereign-portability-hooks-exportimportdelete)                                    |
| 0.26.0 | App-level field encryption for `visit.note` (RFC 0092)        | ✅     | [T.24](SPEC.md#t24--app-level-field-encryption-for-visitnote-rfc-0092)                                 |
| 0.27.0 | App switcher & account menu chrome `[parallel]`               | ✅     | [T.5a](SPEC.md#t5a--app-switcher--account-menu-chrome-parallel-with-t6)                                |

Phase 1 is now complete — every task above, web and mobile data layer alike,
has shipped. `T.24` and `T.5a` were both tagged deferred/non-blocking (not
required for phase 1 to ship) but were picked up on request rather than
left open.

**Not yet slotted, deliberately** (per `CONCEPT.md`'s "Deferred, not yet
planned" and "Future (deferred): trip navigation & route optimization"):
mobile UI beyond check-in capture and Trip Mode's data layer, the full
single-page trip-details view, the "planned vs. actual" comparison view, and
Phase 2a/2b route optimization. None of these have task IDs yet — they get
slotted once their own concept-review/design pass happens.

## Prioritization rationale

- **Web shell (`T.5`) ships early in Slice 1**, right after the check-in
  data layer (`T.4`) — every subsequent web screen (`T.6`, and all of
  Phase 1b) mounts inside `ThreeColumnLayout` + the sidebar it builds, so
  nothing web-facing after it should be built against a placeholder page.
- **`shell: "minimal"`, not `"default"`.** This roadmap's first pass had
  `"default"`; corrected once the web UI concept-review settled on a
  self-rendered `ThreeColumnLayout` sidebar — pairing that with the
  platform's own header/footer chrome would double up navigation, the same
  reasoning `sovereign-plugin-kanban` and `sovereign-plugin-docs` both
  document for the same choice.
- **`T.5a` (apps switcher + account menu) was slotted right after `T.5`,
  not left to drift to the end — in intent, not in outcome.** It's real,
  user-visible chrome (not cosmetic), and nothing in Slice 1/2's own build
  order needed it to function, so it was deliberately non-blocking: land
  whenever convenient without holding up `T.6` onward. In practice "whenever
  convenient" never arrived on its own — it shipped at `0.27.0`, after every
  other phase 1 task including the optional `T.24`, once explicitly asked
  for. The lesson, not repeated elsewhere in this roadmap: a `[parallel]`
  task with zero downstream dependents has no forcing function of its own
  and can sit indefinitely unless someone deliberately picks it back up.
- **Check-ins viewing (`T.6`, web) before check-in capture (`T.7`,
  mobile)** — `T.6` clusters with the rest of Slice 1's web-shell-based work
  (`T.5` onward), while `T.7` is this slice's one mobile-only task, and
  mobile UI overall hasn't been through its own concept-review pass yet
  (see `CONCEPT.md`). `T.2`'s dev seed data means `T.6` is verifiable before
  `T.7` exists.
- **Swarm import (`T.8`) lands after the Check-ins screen exists (`T.6`)**
  — imported history needs a real screen to show up in immediately. Still
  blocked on obtaining a real Swarm export (research doc open question)
  regardless of slot order.
- **Data/server-layer tasks (`T.10`–`T.12`) precede the UI that consumes
  them (`T.13`–`T.16`)**, same principle `sovereign-plugin-kanban` used.
- **Trips (`T.13`–`T.14`) before Planner (`T.15`–`T.16`)** — Planner's "New
  trip" entry point uses the same create-trip modal `T.13` builds; Trips is
  also the simpler of the two screens.
- **`T.10`, `T.11`, and `T.14` carry a conditional fork**: whether
  `travellog_trip_members` (real shared trip access) gets built depends on
  CONCEPT.md open question 2 being confirmed before these start. If it
  resolves toward companion-tags instead, all three tasks' scope shrinks
  accordingly — see each task's own note in `SPEC.md`.
- **Offline wiring (`T.21`) is deliberately second-to-last** — the one task
  in this roadmap with a real external dependency (platform workstream
  0008's offline-first mechanics, still in progress as of this writing).
- **Portability hooks (`T.23`) come after the full phase 1 schema is
  stable (`T.22`)** — exporting a schema that's still changing weekly is
  wasted rework.
- **Field encryption (`T.24`) is explicitly optional and deferred** — it
  protects one column (`visit.note`) behind an operator opt-in that doesn't
  exist in most self-hosted instances yet. Pick it up on request, not by
  default.
