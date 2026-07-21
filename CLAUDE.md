# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**WhereHouse** — a chat agent that answers *"where should I open a bakery / pharmacy /
gym?"* with a **live map**, not a paragraph. Built for the ClickHouse ×
Trigger.dev Virtual Summer Hackathon 2026 (17–23 July).

Demo cities: **Berlin, Amsterdam, Belgrade**.

The repo is currently **research + scaffolding**. No application code yet — read
`docs/research/findings.md` first, it is the distilled output of five research agents
plus live verification against our own ClickHouse service.

## Start here in a new session

```sh
./infra/check-env.sh    # verifies every credential against the live services, ~5s
```

Everything is in `.env` (gitignored): ClickHouse, the public read-only `site` user,
the Cloud API key, managed Postgres, Trigger.dev. `.secrets/pg-ca.crt` holds the Postgres CA.

`ANTHROPIC_API_KEY` **is set** and points at DeepSeek via `ANTHROPIC_BASE_URL`
(`deepseek-v4-flash` — DeepSeek speaks the Anthropic wire format, so `@ai-sdk/anthropic` works
unchanged; drop `ANTHROPIC_BASE_URL` to fall back to Anthropic proper). `check-env.sh` proves
the model responds and prints the balance — **watch it: $4.87 on 19 July.** Enough for a day of
iteration, not a week of demos, and the video is due on the 22nd.

*(This line said "not set yet" until 20 July, long after it was set. A day-4 agent read that,
believed it, and reported a live check as impossible — the exact failure principle II names,
committed against our own stale doc rather than a vendor's. Stale docs lie like state fields
do.)*

Two traps this script exists to catch:
- **`POSTGRES_URL` must stay quoted in `.env`** — an unquoted `&` aborts `source .env` and
  silently drops every line below it (looked exactly like a missing Trigger.dev key).
- The ClickHouse service **idles after 15 min**; the first query wakes it and may be slow.
  A single timeout is not an outage.

## Where we are

[`docs/PLAN.md`](docs/PLAN.md) is the day-by-day plan to the deadline, what's explicitly
cut, and the risk register. **Read it before deciding what to work on.**

The full answer flow is **built and live in prod** — both the Trigger.dev agent
(`./infra/deploy-trigger.sh`) and the static UI (`./infra/deploy-app.sh`) are deployed, so
https://app.slim-shaggy.com works with no local process running. `chat.agent()` behaves as
documented (ADR-001 proven live on day 2: two writes to one `id` produced `parts=1`, content
changed — parts merge on `type`+`id`, last write wins). The day-3 answer flow plus the whole
F1–F5 backlog shipped and were browser-verified; specs are in `specs/`.

The agent exposes **14 tools** (`web/src/trigger/chat.ts`): eight build the map/data answer
(`findCompetitors`, `scoreArea`, `showBuiltCapacity`, `rankSites`, `showCatchment`,
`saveSite`, `compareSavedSites`, `categoryTrend`) and six let it drive the UI itself
(`setLayer`, `reweight`, `focusPick`, `highlightExtreme`, `reviewRun`, `exportReport`).

**Latest: feature 007 — consultant ranking variety** (`specs/007-consultant-ranking-variety/`),
shipped and deployed to prod (agent + UI). `rankSites` is no longer a fixed balanced top-3: it
takes optional `strategy` (balanced|demand|low_competition|accessible), `order` (best|worst =
where to avoid, saturated), `district` (rank within one neighbourhood, e.g. Neukölln), and
`count`/`page` (up to 6 pins, paging) — all over the SAME scored candidate-cell CTE. The
balanced default is byte-for-byte unchanged (FR-002).

Two design facts that still bind (retired as risks, kept as constraints):

1. **The chat stream caps a single record at ~1 MiB**, `data-map` parts included. The handle
   path — browser fetches GeoJSON straight from ClickHouse (ADR-003 proved CORS-open HTTP) — is
   live and carries every over-budget layer. Never stream a wide layer inline. See trap 8 / ADR-001.
2. **Demand is real.** `geo.population` holds Kontur Population — 475k H3 res-8 cells, natively
   the same unit as `geo.places.h3_8`, so the GAP score joins on equality with no interpolation.
   `./infra/load-population.sh` (re)loads and verifies it. Attribution (Kontur, CC BY) is
   **required** wherever the map is shown.

## Spec-Driven Development — MANDATORY

This project uses [spec-kit](https://github.com/github/spec-kit) (v0.12.18). **Non-trivial
features go through the spec-driven cycle — this is not optional.** Artifacts live in
`specs/`.

1. `/speckit-constitution` — project principles (`.specify/memory/constitution.md`)
2. `/speckit-specify` — the spec
3. `/speckit-plan` — implementation plan
4. `/speckit-tasks` — task breakdown
5. `/speckit-implement` — build it

Optional, for quality: `/speckit-clarify` (before `/speckit-plan`), `/speckit-analyze`
(after `/speckit-tasks`, before `/speckit-implement`), `/speckit-checklist` (after
`/speckit-plan`).

**[`.specify/memory/constitution.md`](.specify/memory/constitution.md) outranks this file.**
Read it before planning anything. If the two disagree, the constitution wins and this file
gets fixed. Its six principles are distilled from what actually went wrong on day 1 —
notably *"claims are verified against the live system, not the docs"* and *"prove the
riskiest path first"*.

**Proportionality:** this is a 6-day hackathon. Spec-driven means *think before you type*,
not *generate paperwork*. Trivial changes go direct. The test: *would getting this wrong
cost more than an hour?* A spec that takes longer to write than the feature takes to build
violates constitution principle VI.

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

**ClickHouse-managed Postgres** — `wherehouse-oltp`, pg18, eu-west-1, OLTP side of
ADR-004. Credentials in `.env`. **`psql` needs the CA cert**, `sslmode=require` alone
fails verification:

```bash
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"   # psql isn't on PATH by default
curl -s -u "$CLICKHOUSE_API_KEY_ID:$CLICKHOUSE_API_KEY_SECRET" \
  ".../postgres/$PG_ID/caCertificates" -o .secrets/pg-ca.crt   # raw PEM, not JSON
psql "$POSTGRES_URL&sslmode=verify-full&sslrootcert=.secrets/pg-ca.crt" -c "SELECT 1"
```
`.secrets/` is gitignored. ClickPipe `wherehouse-pg-cdc` replicates
`public.{shortlists,saved_sites}` → `oltp.pg_*` every 10 s.

**Trigger.dev** — project `trigger-dev-hackathon` (`proj_klnembmmwmnxxishtmvf`), task
`wherehouse-chat` (`web/src/trigger/chat.ts`). Two environments, two keys, both in `.env`:

- `TRIGGER_SECRET_KEY` (`tr_dev_…`) — a local `pnpm exec trigger dev` process authenticates
  as this. Local-dev-only; nothing else should ever hold it.
- `TRIGGER_SECRET_KEY_PROD` (`tr_prod_…`) — what the deployed Cloudflare Worker
  (`infra/app-worker/`) holds as its `TRIGGER_SECRET_KEY` secret, so the live site
  (https://app.slim-shaggy.com) works with **no local process running at all**. Fetched
  from the API, never typed in by hand — see `infra/deploy-trigger.sh`.

`./infra/deploy-trigger.sh` ships the task to prod and wires everything up (idempotent):
`env` (import the task's runtime env vars into the Trigger prod environment) → `deploy`
(`trigger deploy`) → `key` (fetch `TRIGGER_SECRET_KEY_PROD` into `.env`) → `rewire` (point
the Worker's secret at it) → `verify` (curl smoke test). Run the whole thing with no
argument. `infra/deploy-app.sh`'s Worker deploy step reads `TRIGGER_SECRET_KEY_PROD`, not
`TRIGGER_SECRET_KEY` — so rebuilding the site (a UI change, say) can never silently flip
the live Worker back to the dev key.

Two things this had to discover the hard way (day 5), both fixed in code/scripts, not by
hand:

- **`trigger deploy` imports every task file in a remote build container as part of the
  build** ("indexer" step) — any `process.env.X` read eagerly at module load runs THERE
  too, not only inside a task run. `web/src/lib/pg.ts` used to build its Postgres `Pool`
  (and read the CA cert file) unconditionally at import time — meaning *every* chat
  message, not just `saveSite`, would have crashed the deployed task with no way to supply
  `.secrets/pg-ca.crt` in a deployed container. Fixed: `pg.ts` now prefers a
  `POSTGRES_CA_CERT` env var (set by `deploy-trigger.sh env`) over the local file; the file
  read is the local-dev fallback. Import the env vars *before* deploying — the indexer
  step reads whatever's already in the prod environment.
- **No CLI subcommand imports env vars or fetches a project's prod secret key** (`trigger
  env` only has `list`/`get`/`pull`). Both go through the REST API
  (`POST /projects/{ref}/envvars/{env}/import`, `GET /projects/{ref}/prod`) — and both
  **reject** the short-lived `tr_uat_…` token from `trigger mint-token` ("Invalid or
  Missing API key", verified against both endpoints despite the command's own docstring
  reading like it should work). Only the raw personal access token from `trigger login`
  is accepted; `deploy-trigger.sh` reads it straight out of the CLI's own config file
  rather than reinventing a login flow.

Rollback if the prod path ever wedges: `wrangler secret put TRIGGER_SECRET_KEY` in
`infra/app-worker/`, pasting the `tr_dev_…` key, then run `pnpm exec trigger dev` locally
as before — that path was never touched by the prod rewire.

Tooling on this machine: node 26, pnpm 10.33, `gh` authed as `andrewkomkov`.

## Traps that have already bitten us

Read these before writing any geo SQL. Each cost real time today.

1. **The whole H3 family is LAT-FIRST.** Every other ClickHouse geo function is `(lon, lat)`.
   - `geoToH3(lat, lon, res)` — Overture's `geometry.1` is lon, `geometry.2` is lat, so it's
     `geoToH3(geometry.2, geometry.1, 8)`. Getting it backwards is **silent**: counts look
     plausible, hexes land in the Indian Ocean. **Only ever compute H3 in a `MATERIALIZED`
     column**, never inline.
   - `h3ToGeo(h3)` returns **`(lat, lon)`** — verified 19 Jul:
     `h3ToGeo(stringToH3('881f1d4881fffff'))` → `(52.5236, 13.3737)`. A bbox filter written
     as `h3ToGeo(h3).1 BETWEEN <lon range>` returns **zero rows with no error** — an empty
     map, not a crash. This one bit the day-3 scoring query while it was being written.

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

   But note the flip side, found 19 Jul: Overture's `geometry` column **already arrives as a
   native `Geometry` type** (a Variant) from `s3(...)` parquet. So `readWKB(geometry)` is
   *wrong* and fails with `ILLEGAL_TYPE_OF_ARGUMENT`. Use
   `variantElement(geometry, 'Polygon')` / `'MultiPolygon'` — check `variantType(geometry)`
   first. `pointInPolygon((lon, lat), poly)` then works and is sub-second behind a `bbox`
   prefilter. (`theme=divisions/type=division_area`: `subtype='macrohood'` = Ortsteil,
   `'locality'` = Bezirk.)

7. **`http_response_headers` quoting uses doubled single quotes**, not `"` —
   `'{''Content-Type'':''text/html''}'`. `"` fails with `CANNOT_PARSE_QUOTED_STRING`.

8. **The chat stream caps a single record at ~1 MiB**, `data-map` parts included, and it
   cannot be raised. We already exceed it (Berlin food & drink = 1.27 MiB). See ADR-001.

9. **Don't copy the Trigger.dev docs' `UIDataTypes & { … }` typing** — `UIDataTypes` is
   `Record<string, unknown>`, so intersecting widens `keyof` to `string`, degrades the part
   type to `` `data-${string}` `` with `data: unknown`, and silently kills every bit of
   client-side narrowing. Declare the shape bare: `type Foo = { map: MapData }`.

## Architecture decisions (ADRs — read before changing direction)

- [`docs/architecture/progressive-map.md`](docs/architecture/progressive-map.md) —
  **ADR-001**: the map *is* the response. `chat.response.write({type:"data-map", id})`
  with a stable `id` updates the part **in place**, so the map fills in progressively as
  the agent works. Full GeoJSON goes to the UI; the model only sees `{ rowCount }`.
- [`docs/architecture/data-sources.md`](docs/architecture/data-sources.md) —
  **ADR-002**: Overture Maps parquet on public S3, queried in place via `s3()`. No OSM
  PBF pipeline. Berlin histogram in 4.0 s cold; bakery H3 density in 1.1 s.
- [`docs/architecture/clickhouse-as-webserver.md`](docs/architecture/clickhouse-as-webserver.md) —
  **ADR-003**: the "entire service hosted on ClickHouse" stunt. **Built and live** —
  `https://app.slim-shaggy.com` serves the real app, static-exported and loaded row-by-row
  into `web.assets`, via the Cloudflare Worker in `infra/app-worker/`
  (`./infra/deploy-app.sh` rebuilds/redeploys). The Worker also fronts the three
  server-side ops the static export has no runtime for (Trigger token mint + session
  start, Postgres save/list via **Hyperdrive** — raw Workers TCP sockets can't validate
  our Postgres's private CA, Hyperdrive can). CORS-open direct-to-ClickHouse queries from
  the browser (the original proof) are still how the map's own data loads.
- [`docs/architecture/oltp-olap.md`](docs/architecture/oltp-olap.md) —
  **ADR-004**: ClickHouse-managed Postgres → ClickPipes CDC → ClickHouse. **Built and
  verified** (~20 s end-to-end). Targets the OLTP+OLAP bonus prize. The point is the
  join: a user's saved site (seconds old, from Postgres) against 75M Overture POIs.

## Key facts worth not re-deriving

- Overture release rotates; current is `2026-06-17.0`. Enumerate, don't hardcode:
  `curl -s "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&delimiter=/&prefix=release/"`
- Berlin metro basemap (Protomaps PMTiles, z0–14) is **30.8 MB, cut in 20.3 s** (measured;
  the old "5.8 s" was a `--dry-run`, which never downloads). Three cities < 100 MB.
  **Already built and live** at `https://basemap.slim-shaggy.com/berlin/{z}/{x}/{y}.mvt` —
  rebuild with `./infra/basemap.sh`.
- ClickHouse has **no routing**. Valhalla alongside. Bridge:
  `h3PolygonToCells(isochrone, 8)` → `WHERE h3_8 IN (…)` turns geometry into an indexed
  equality lookup.
- The neighbouring repo `../opengridworks-CMS` already runs Valhalla + tileserver +
  MapLibre. Lift `server_threads: "1"` (multithreaded tile build segfaults) and
  `max_time_contour ≥ 480`. Its `recolorAtdi()` client-side re-weighting pattern is
  directly reusable.

## Infrastructure is code — keep it that way

Everything (ClickHouse service, managed Postgres, ClickPipes CDC) was provisioned
through the **Cloud REST API**, never the console, and lives in `infra/`:

```sh
./infra/status.sh                 # read-only: what's running, versions, CDC freshness
./infra/provision.sh              # rebuild everything from nothing (idempotent)
./infra/basemap.sh                # cut city PMTiles → R2 → deploy the tile worker
./infra/teardown.sh               # destroy billables (run after judging, 29 July)
```

The basemap lives on **Cloudflare**, not ClickHouse: R2 bucket `wherehouse-basemaps` +
worker `wherehouse-basemap` on `basemap.slim-shaggy.com` (`infra/basemap-worker/`, the
upstream Protomaps worker vendored). Auth is wrangler OAuth (`wrangler login`) — there is
no Cloudflare credential in `.env`, so `check-env.sh` does not cover it. Adding a city =
one line in the `CITIES` array in `infra/basemap.sh`.

**Rule: if you change infrastructure, change `infra/` in the same breath.** A console
click is a bug — the deadline is server-enforced, and if the service has to be recreated
at 2am on 22 July that must be one command, not archaeology.

The live OpenAPI spec at `https://api.clickhouse.cloud/v1` is ground truth — read it
instead of guessing field names.

There is a dedicated subagent for this: **`infra-keeper`** (`.claude/agents/`). Use it
for provisioning, diagnosing CDC/pipe failures, spend checks and teardown; it carries
the accumulated API gotchas.

Shell style note: `cmd | python3 - <<'PY'` **steals stdin** and the pipe never arrives.
Use `cmd | python3 -c "$(cat <<'PY' … PY)"`. This bit us in `status.sh`.

## Agents & skills — where the hard-won know-how lives

Domain knowledge is packaged so it doesn't have to be rediscovered. Load the skill (or use the
agent) for the matching task instead of re-deriving:

| Agent (`.claude/agents/`) | Skill (`.claude/skills/`) | For |
|---|---|---|
| `infra-keeper` | — | ClickHouse/Postgres/CDC provisioning, pipe failures, spend, teardown — Cloud REST API gotchas |
| `video-director` | `wherehouse-video` | The demo video: Playwright capture, Remotion compose, Gemini voice+music, ffmpeg mux. Carries every trap (fake-4K capture, audio `asplit`/loudnorm-pumping/sidechain music-cut, Lyria-mpeg, atempo-fit, multi-source timeline, ClickHouse `/play` console, encode CRF). |
| `project-validator` | `wherehouse-validate`, `wherehouse-categories` | Prove features are real vs the LIVE system (per-tool SQL, headless `chat.agent()` run, no-fakery audit, hard rules); add/remove/audit queryable trades (the Overture-vs-friendly naming trap, "make it shine"). |

Skills are also user-invocable (`/wherehouse-video` etc.). The detail lives in the SKILL.md; the
agents are the operators that load them.

## CI and releases

`.github/workflows/ci.yml` runs on every push/PR:
- **gitleaks + a tracked-credentials check** — the load-bearing job. The repo goes public
  on 23 July with live keys in a local `.env`; this is the seatbelt. Never weaken it.
- **shellcheck** on `infra/*.sh` (`--severity=warning`, currently clean)
- **sql sanity** — applies `db/postgres/001_oltp_schema.sql` to a real `postgres:18-alpine`
  service container and asserts publication `wherehouse_pub` exists (CDC breaks without it).
  No credentials needed.
- **docs links** — relative markdown links must resolve.

Releases are automated by [release-please](https://github.com/googleapis/release-please)
from Conventional Commits (`release-please-config.json`, `.release-please-manifest.json`).
Merging the `chore: release main` PR tags and updates `CHANGELOG.md`. Note the repo
setting `default_workflow_permissions=write` + `can_approve_pull_request_reviews=true`
had to be enabled via the API — without it release-please fails with
*"GitHub Actions is not permitted to create or approve pull requests"*.

## Conventions

- Conventional Commits; description lowercase, imperative, no trailing period.
  No AI/Claude attribution in commit messages.
- Docs and ADRs in English (the repo goes public to an international jury); talk to the
  user in Russian.
- When a claim matters, **verify it against the live service** rather than trusting docs
  — three of the traps above were doc-invisible.
- **That includes prose you write yourself** (constitution II, amended 1.1.0). A sentence in
  a spec is a claim. Day 3: the agent was banned from naming districts it invented — and the
  spec doing the banning asserted three district names that were *also* invented, eyeballed
  from coordinates, all three wrong. Verified numbers next to a sentence do not verify the
  sentence. If nothing you can run would prove a statement false, you have decorated it, not
  checked it.
