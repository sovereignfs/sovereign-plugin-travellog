# Sovereign Travellog

A private, self-hosted trip planner and personal place check-in log, built
as an installable plugin for the
[Sovereign](https://github.com/sovereignfs/sovereignfs) platform
(`fs.sovereign.travellog`).

See [CONCEPT.md](CONCEPT.md) for the product concept, [SPEC.md](SPEC.md) for
the technical design and task breakdown, and [ROADMAP.md](ROADMAP.md) for
build order. [CLAUDE.md](CLAUDE.md)/`AGENTS.md` cover developing this plugin
inside a `sovereignfs/sovereignfs` monorepo checkout.

## Environment variables

### `SV_PLUGIN_FS_SOVEREIGN_TRAVELLOG_NOMINATIM_BASE_URL` (place search)

Base URL of the [Nominatim](https://nominatim.org/) (or Photon-compatible)
instance used for place search and reverse geocoding — read via the
plugin-scoped env mechanism (`sdk.env`, RFC 0018). No trailing slash.
Defaults to the public OpenStreetMap Nominatim instance
(`https://nominatim.openstreetmap.org`) when unset.

The public instance is rate-limited client-side to its own usage policy (max
1 request/second) and results are cached in-process — polite defaults, not
a substitute for self-hosting if your instance does meaningful search
volume. Point this at your own Nominatim (or Photon) deployment for higher
throughput or to keep place-search queries off a third-party service
entirely:

```bash
SV_PLUGIN_FS_SOVEREIGN_TRAVELLOG_NOMINATIM_BASE_URL=https://nominatim.example.com
```

Place search never depends on this being reachable — a plugin-local search
over your own previously-created places always runs alongside it, and
creating a place manually (name only, no external search) always works.

## Data protection

A check-in's free-text note (`visit.note`) is classified `sensitive` under
the platform's app-level field encryption (RFC 0092). If the operator has
enabled it for that class, the note is stored as ciphertext — an operator
with a live database connection sees an opaque envelope, not the note text.

**Not covered:** coordinates, timestamps, place names, and categories stay
plaintext — the map, auto-link engine, and search all read them directly, so
encrypting them isn't possible without breaking those features. Only the
note itself is classified.

This is entirely operator policy, off by default, and this plugin behaves
identically either way — see the platform's `docs/self-hosting.md`
("Field encryption") for how to enable it instance-wide.
