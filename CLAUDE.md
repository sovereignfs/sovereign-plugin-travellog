# CLAUDE.md — sovereign-plugin-travellog

Guidance for Claude Code (and other agents) working in this repository.

## What this is

**Sovereign Travellog** — a private, self-hosted trip planner and personal
place check-in log, built as an installable plugin for the
[Sovereign](https://github.com/sovereignfs/sovereignfs) platform
(`fs.sovereign.travellog`). Combines trip planning (Wanderlog/Wanderlust-style)
and a personal check-in lifelog (Swarm-style) around one idea: checking in is
always available and stands on its own; a trip is just an optional folder a
check-in falls into automatically when the timing matches.

## Where this runs

This repo has no build/test/lint tooling of its own — it depends on
`@sovereignfs/sdk`, `@sovereignfs/ui`, and `@sovereignfs/tsconfig`
(`workspace:*`), which only resolve inside a `sovereignfs/sovereignfs`
monorepo checkout's pnpm workspace.

Develop this plugin by cloning this repo into that monorepo at
`plugins/sovereign-plugin-travellog.local/` (the trailing `.local` marks it
as a locally-cloned dev plugin — see that repo's `docs/plugin-development.md`)
and running the monorepo's own commands from its root, filtered to this
package where useful:

```bash
pnpm install                                         # resolves workspace: deps
pnpm dev                                              # composes + hot-reloads this plugin
pnpm --filter sovereign-plugin-travellog typecheck
pnpm lint / pnpm format:check / pnpm design:tokens:check   # repo-wide, not per-plugin
pnpm exec vitest run plugins/sovereign-plugin-travellog.local
```

`.local` plugin directories are gitignored by the monorepo, so this repo's own
git history (not the monorepo's) is this plugin's only version control while
it lives there.

## Source of truth

Read the relevant doc before any task — these are authoritative over
assumptions:

- [`CONCEPT.md`](CONCEPT.md) — product concept: the two-spine model
  (`trip`/`stop` vs. `visit`), the decided scope (one plugin, no reward
  mechanics), the web UI (`ThreeColumnLayout`, the Trips/Check-ins/Planner
  sidebar), what's explicitly deferred (mobile UI, the full trip-details
  page, route optimization), and the open questions still carried forward.
- [`SPEC.md`](SPEC.md) — technical spec: architecture, data model, and every
  task (`T.1`–`T.24`, plus `T.3a`) with its goal, deliverables,
  dependencies, and review checklist. Its `Status` section will carry a
  detailed narrative for every completed task, including bugs found live and
  scope decisions — read it, don't just skim the checkbox, once it has
  entries.
- [`ROADMAP.md`](ROADMAP.md) — prioritized build order, one row per task,
  with manifest-version-tracked slots and the reasoning behind the ordering.

## Task workflow

**One task at a time.** Implement a single `T.<n>` task, verify its SPEC
review checklist, then stop. Tasks are sequenced — each depends on the
previous unless SPEC marks it `[parallel]`. Don't skip ahead without being
told which task to pick up next.

Per-task loop:

1. Read the task's Goal/Deliverables/Dependencies/Review checklist in
   `SPEC.md`. Check whether the task carries a conditional note (e.g. `T.10`/
   `T.11`/`T.14`'s trip-sharing fork) and confirm which branch applies before
   starting, rather than assuming.
2. If it introduces a new screen or a materially new layout, produce a
   wireframe/design doc under `docs/adhoc/` first and get it signed off — per
   the `sv-ui-design` skill.
3. Implement, following the conventions below.
4. **Verify live in a browser**, not just via the check suite. Two classes of
   bug this plugin is unusually exposed to, worth specific attention every
   time they're touched:
   - **Timezone/DST correctness** — every `visit` and `trip_day` carries real
     wall-clock semantics (UTC + IANA zone + local offset); a trip whose stop
     spans a DST transition or a visit read back in a different user's
     timezone are the concrete cases `SPEC.md` calls out as required test
     coverage, not just nice-to-haves.
   - **The `ThreeColumnLayout` detail column** is driven by local component
     state (a selected id), not a route — verify the third column appears/
     clears correctly on selection and doesn't survive a navigation it
     shouldn't.
5. Run the full check suite (typecheck, lint, format:check, vitest, design
   tokens) and show the output.
6. Bump `manifest.json`'s `version`, mark the task ✅ in `ROADMAP.md`, and add
   a detailed status entry to `SPEC.md` — in that order.

## Conventions (inherited from the host platform, still binding here)

This plugin is a guest in the Sovereign platform's runtime — these rules
exist to keep it a well-behaved one. Full rationale for each lives in the
platform repo's `docs/architecture-rules.md`.

- **SDK boundary:** import only `@sovereignfs/sdk` and `@sovereignfs/ui`.
  Never reach into the platform's `runtime/src` — plugins don't have access
  to it once installed, and the monorepo's ESLint config enforces this at
  lint time.
- **Every server action** (`app/actions.ts`) starts with
  `sdk.auth.requireSession()`, then a specific per-resource authorization
  check — visit ownership, trip ownership, or (once/if `travellog_trip_members`
  exists per `T.10`'s conditional scope) trip membership. Route-level gating
  is never sufficient — an action is a public POST endpoint dispatched by
  action id.
- **Mutations return `ActionResult`** — domain failures are values
  (`fail(...)`), never thrown. A non-owner/non-member denial should read as
  "not found" rather than "forbidden" so resource existence isn't leaked.
- **Trip-date recomputation happens in the same transaction as the stop
  mutation that triggers it** (`SPEC.md`'s Data model notes): adding, editing,
  reordering, or removing a `travellog_stops` row must recompute the trip's
  denormalized `start_date`/`end_date` and adjust `travellog_trip_days` rows
  atomically — never as a follow-up write that could leave the two out of
  sync.
- **Ordering uses fractional positions** (stops, itinerary items) — midpoint
  insertion, renormalize the whole scope in one transaction when a gap
  underflows. A reorder/move is exactly one row write, never a multi-row
  shuffle. Match `sovereign-plugin-kanban`'s `_db/position.ts` approach rather
  than re-deriving it.
- **Design system only:** components and semantic `--sv-*` tokens from
  `@sovereignfs/ui`, never hardcoded colors or bespoke primitives —
  `pnpm design:tokens:check` (run from the monorepo root) enforces this,
  including any plugin-local map styling once a map exists.
- **Plugins version only `manifest.json`.** `package.json`'s `version` stays
  pinned at `0.0.0` forever — the manifest's `version` is the sole source of
  truth the platform reads (registry, compatibility checks, export/import).
- **Tests run against real generated migrations** on an ephemeral libsql DB,
  with the SDK mocked to impersonate switchable users. Per action group: an
  authz-denial-without-side-effects test, then a happy-path test.

## Naming

Match the host platform's split: **plugin** in code/types/schema
(`travellog_trips`, `TripData`, `routePrefix`), **trip/stop/check-in/place**
— never "plugin" — in user-facing UI strings.

## What's deliberately not designed yet

Don't invent detail here ahead of its own pass — flag it and ask instead:

- **Mobile UI**, beyond the check-in-capture and Trip Mode data plumbing
  `SPEC.md`'s `T.7`/`T.19` already scope. The actual mobile screens haven't
  been through a concept-review pass (`CONCEPT.md`'s "Deferred, not yet
  planned").
- **Route optimization** (`CONCEPT.md`'s "Future (deferred)" section) — the
  proximity (2a) and routing-aware (2b) Trip Mode enhancements. Phase 1's job
  is only to not block them (the fixed/flexible split, real coordinates),
  never to build them.
- **The full single-page trip-details view** and the richer "planned vs.
  actual" comparison view that depends on it.

## Status

Current manifest version: `0.14.0` (`T.1`–`T.12` shipped — Slice 1 web is
feature-complete; Slice 2's data model, server layer, and auto-link engine
now exist, with one small but real UI touchpoint — the Check-ins detail
column's Unlink action — live. `T.13` (Trips screen) is next, the first
task with a full screen for a user to actually see). Task history and the
reasoning behind every completed task lives in `SPEC.md`'s `Status`
section — that's the changelog; don't duplicate it here.
