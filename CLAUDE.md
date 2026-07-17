# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**WhereHouse** — a chat agent that answers *"where should I open a bakery / pharmacy /
kindergarten?"* with a **live map**, not a paragraph. Built for the ClickHouse ×
Trigger.dev Virtual Summer Hackathon 2026 (17–23 July).

Demo cities: **Berlin, Amsterdam, Belgrade**.

The repo is currently **research + scaffolding**. No application code yet — read
`docs/research/findings.md` first, it is the distilled output of five research agents
plus live verification against our own ClickHouse service.

## Non-negotiable constraints (from the hackathon rules)

These override normal engineering judgement — they are scoring criteria.

- **The answer must be visual.** Theme is *"Beyond the Wall of Text"*; judging lens is
  *"ratio of insight to words"*. If the agent's best answer is a paragraph, we lose.
- **ClickHouse must be the primary database.** Not a cache, not a sidecar.
- **Must use Trigger.dev `chat.agent()`** specifically. Superficial use = disqualified.
- **Repo must be PUBLIC under MIT by 23 July 00:00 AoE.** It is private *now* on
  purpose (rules forbid sharing approaches with other teams). ⇒ **Never commit `.env`
  or any credential file.** `.gitignore` covers `.env`, `*api-key*.txt`,
  `*credentials*.json`. Secrets live in `.env` locally; `.env.example` is the committed
  contract.
- **All code must be written inside the build window** (opened 17 Jul 09:00 CET).
- Deadline is server-enforced. No extensions.

## Live infrastructure

**ClickHouse Cloud** — service `trigger-dev-hackathon`, **26.4** (`fast` channel), eu-west-1.
Host, credentials and org/service IDs are in `.env`. IP access list is open (0.0.0.0/0).

The Cloud REST API is scriptable with the API key in `.env` — use it to inspect or
change the service instead of asking the user to click in the console:

```bash
curl -s -u "$CLICKHOUSE_API_KEY_ID:$CLICKHOUSE_API_KEY_SECRET" \
  https://api.clickhouse.cloud/v1/organizations/$ORG/services/$SVC
```

Quick SQL check:
```bash
curl -s --user "default:$CLICKHOUSE_PASSWORD" "$CLICKHOUSE_URL/" --data-binary "SELECT version()"
```

**Trigger.dev** — `TRIGGER_SECRET_KEY` in `.env`. Project not yet initialised
(`npx trigger.dev@latest init`).

Tooling on this machine: node 26, pnpm 10.33, `gh` authed as `andrewkomkov`.

## Traps that have already bitten us

Read these before writing any geo SQL. Each cost real time today.

1. **`geoToH3(lat, lon, res)` is LAT-FIRST.** Every other ClickHouse geo function is
   `(lon, lat)`. Overture's `geometry.1` is lon, `geometry.2` is lat — so it's
   `geoToH3(geometry.2, geometry.1, 8)`. Getting it backwards is **silent**: counts look
   plausible, hexes land in the Indian Ocean. **Only ever compute H3 in a `MATERIALIZED`
   column**, never inline.

2. **Filter Overture on `bbox.*`, never on `geometry`.** `bbox` is plain floats, so
   Parquet row-group stats prune ~everything. Filtering `geometry` forces a full decode.

3. **`readonly=1` blocks per-query `http_response_headers`** (`Code: 164`). It must be
   baked into a SETTINGS PROFILE as `READONLY` ⇒ one profile+user per content-type.

4. **Never run access DDL (`CREATE USER/SETTINGS PROFILE`) during a version upgrade.**
   We wedged `p_html` / `web_html` / `web_html2` that way — `CREATE` says "already
   exists in `replicated`", `DROP`/`ALTER` say "there is no settings profile". Use fresh
   names; don't try to repair those.

5. **`polygonAreaSpherical` returns steradians, and its sign follows ring winding.**
   Always `abs(...) * 6371007.18^2` for m².

6. **Cloud is 26.4; `GeoJSON` format and MVT (`ST_AsMVT`) need 26.6.** Verified absent.
   Cloud trails open-source ~2 releases — **do not plan on 26.6 arriving before the
   deadline.** Build GeoJSON by hand (`toJSONString` + `map()`).

7. **`http_response_headers` quoting uses doubled single quotes**, not `"` —
   `'{''Content-Type'':''text/html''}'`. `"` fails with `CANNOT_PARSE_QUOTED_STRING`.

## Architecture decisions (ADRs — read before changing direction)

- [`docs/architecture/progressive-map.md`](docs/architecture/progressive-map.md) —
  **ADR-001**: the map *is* the response. `chat.response.write({type:"data-map", id})`
  with a stable `id` updates the part **in place**, so the map fills in progressively as
  the agent works. Full GeoJSON goes to the UI; the model only sees `{ rowCount }`.
- [`docs/architecture/data-sources.md`](docs/architecture/data-sources.md) —
  **ADR-002**: Overture Maps parquet on public S3, queried in place via `s3()`. No OSM
  PBF pipeline. Berlin histogram in 4.0 s cold; bakery H3 density in 1.1 s.
- [`docs/architecture/clickhouse-as-webserver.md`](docs/architecture/clickhouse-as-webserver.md) —
  **ADR-003**: the "entire service hosted on ClickHouse" stunt. **Proven on Cloud** —
  a page stored in a `MergeTree` row serves as real `text/html` over a plain GET, and
  CORS is open so the browser queries ClickHouse directly. Delivery shape still open.

## Key facts worth not re-deriving

- Overture release rotates; current is `2026-06-17.0`. Enumerate, don't hardcode:
  `curl -s "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&delimiter=/&prefix=release/"`
- Berlin metro basemap (Protomaps PMTiles, z0–14) is **31 MB**. Three cities < 100 MB.
- ClickHouse has **no routing**. Valhalla alongside. Bridge:
  `h3PolygonToCells(isochrone, 8)` → `WHERE h3_8 IN (…)` turns geometry into an indexed
  equality lookup.
- The neighbouring repo `../opengridworks-CMS` already runs Valhalla + tileserver +
  MapLibre. Lift `server_threads: "1"` (multithreaded tile build segfaults) and
  `max_time_contour ≥ 480`. Its `recolorAtdi()` client-side re-weighting pattern is
  directly reusable.

## Conventions

- Conventional Commits; description lowercase, imperative, no trailing period.
  No AI/Claude attribution in commit messages.
- Docs and ADRs in English (the repo goes public to an international jury); talk to the
  user in Russian.
- When a claim matters, **verify it against the live service** rather than trusting docs
  — three of the traps above were doc-invisible.
