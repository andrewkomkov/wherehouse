# ADR-003: Serving the web app *from* ClickHouse

**Status:** BUILT AND LIVE — 2026-07-18. `https://app.slim-shaggy.com` — the real Next.js
app (not a demo page), static-exported, loaded row-by-row into `web.assets`, served by the
Cloudflare Worker in `infra/app-worker/` (option C, revised — see below). Verified live:
page loads with zero external requests (fonts self-hosted), a full chat run assembles
(competitor dots, opportunity choropleth, ranked picks, caption) against live ClickHouse +
Trigger.dev, and a save-site write round-trips through Hyperdrive into Postgres and back
into the UI. Rebuild/redeploy: `./infra/deploy-app.sh`.
**Date:** 2026-07-17 (decided) / 2026-07-18 (built)

## Update 2026-07-18 — built as option C, not option A, and why

The section below ("Options for the delivery shape") leaned **A** (Cloud-only, browser
queries ClickHouse directly for the page too) with a Worker "purely for a pretty hostname".
What actually got built is closer to **C**: the Worker is not a thin rewrite — it holds
`TRIGGER_SECRET_KEY` and the Postgres connection as secrets and serves three `/api/*`
routes, because the static export has **no server runtime at all** (no Server Actions, no
API routes), and three operations still need a secret held server-side: minting a
Trigger.dev public token, starting a `chat.agent` session, and the OLTP save/list. All
three were proven to run in workerd *before* anything else was built (constitution III):

- Token mint + session start are pure `fetch` + local HS256 JWT signing (`jose`,
  WebCrypto) — verified against the live Trigger.dev API from both `wrangler dev` and a
  real deployed Worker.
- Postgres needs **Hyperdrive**, not raw `cloudflare:sockets`: a plain TCP socket
  completes the Postgres SSLRequest handshake fine, but Cloudflare's `startTls()` only
  trusts public root CAs, with no custom-CA option — and our managed Postgres presents a
  private, Ubicloud-issued CA (same root cause as the documented `psql sslmode=require`
  failure elsewhere in this doc). Hyperdrive supports a custom CA
  (`--ca-certificate-id`) and was verified end-to-end on a real deployed Worker.

The claim "every byte the browser gets for the page originates in a ClickHouse row" still
holds — `web.assets` (`db/clickhouse/009_app_assets_schema.sql`) holds the whole static
bundle, and the Worker's asset path is a plain read with the existing public `site` user
(no new ClickHouse access DDL). The Worker's `/api/*` routes are the honest exception:
they are server logic, not ClickHouse, and were never claimed to be.

## The stunt

"The entire web service is hosted on ClickHouse." Not ClickHouse-as-the-database-
behind-a-web-server — ClickHouse *as* the web server. No Node, no nginx, no API layer.

This is a deliberate play for two judging criteria: **Innovation (20%)** and
**Use of ClickHouse — "depth, creativity, and correctness" (25%)**.

## What is PROVEN — verified against our own service, not from docs

### 1. ClickHouse Cloud can return `Content-Type: text/html` ✅

The research agent flagged this as "promising but untested — don't build the demo on
it without verifying". We verified it. It works.

`http_response_headers` is a **session setting**, not a config-file directive, so
Cloud accepts it even though Cloud has no `config.xml`:

```sql
SELECT '<!DOCTYPE html><html>…</html>' FORMAT RawBLOB
SETTINGS http_response_headers = '{''Content-Type'':''text/html; charset=UTF-8''}'
```
→ `HTTP/1.1 200 OK` · `Content-Type: text/html; charset=UTF-8` · renders in a browser.

Note the quoting: **doubled single quotes**, not `"`. `"` fails with
`CANNOT_PARSE_QUOTED_STRING`.

### 2. The page can live *in a table* and be served by URL ✅

```sql
CREATE TABLE web.pages (slug String, body String) ENGINE = ReplacingMergeTree ORDER BY slug;
INSERT INTO web.pages VALUES ('index', '<!DOCTYPE html>…');
```
```
GET /?user=site&password=…&query=SELECT%20body%20FROM%20web.pages%20WHERE%20slug%3D'index'%20FORMAT%20RawBLOB
→ 200, text/html, browser renders it
```

The website is a row. Deploying a new frontend is an `INSERT`.

### 3. CORS is open on Cloud by default ✅

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, GET, OPTIONS
Access-Control-Allow-Headers: origin, x-requested-with, …, Authorization
```
Returned **without** `add_http_cors_header=1`. So the browser can query ClickHouse
Cloud directly — no proxy needed for data either.

⚠️ **Refined 19 July — the headers are echoed only when the request carries `Origin`.**
A browser always sends it; `curl` never does unless told. A plain `curl -D-` therefore shows
**no CORS headers at all** and reads exactly like "CORS is broken on Cloud" — it isn't, and
this nearly triggered a redesign of the day-3 handle path. Always test with
`-H "Origin: http://localhost:3000"`. Preflight `OPTIONS` → `204` with the full header set.

Also verified: passing `add_http_cors_header=1` as a URL param **fails with HTTP 500** for a
`readonly=1` user — it's a setting, so it hits the same wall as row 5 of the table below.
It is unnecessary; don't pass it.

### 4. A public read-only user is genuinely safe ✅

```sql
CREATE USER site IDENTIFIED BY '…' SETTINGS PROFILE web_profile, readonly = 1;
GRANT SELECT ON web.* TO site;
```
Verified rejections:
- `CREATE TABLE` → `Code: 497 Not enough privileges`
- `?max_execution_time=600` → `Code: 164 Cannot modify … in readonly mode`
- `SELECT FROM system.users` → `Code: 497 Not enough privileges`

`readonly=1` is not escapable from the client. Same model as `play.clickhouse.com`.

## Cloud-specific constraints we hit (all verified)

| Constraint | Detail |
|---|---|
| No `config.xml` | ⇒ **no `http_handlers`**, ever, on any version. No clean `/tile/{z}/{x}/{y}` URLs — everything is `/?query=…`. This is config-file-gated, *not* version-gated. |
| `allow_no_password = 0` | Anonymous users rejected: `Authentication type NO_PASSWORD is not allowed`. Public user must carry a password (public token, like Mapbox's). |
| `allow_plaintext_password = 0` | `PLAINTEXT_PASSWORD` rejected too. Use default `IDENTIFIED BY` (sha256). |
| Password complexity enforced | ≥12 chars, 1 digit, 1 uppercase, 1 special. |
| `readonly=1` blocks per-query `http_response_headers` | `Code: 164`. **Must** be baked into a SETTINGS PROFILE as `READONLY`. ⇒ one profile+user per content-type (`site_html`, `site_json`, `site_tiles`). |

## Version reality — this bit the plan

Cloud **`fast` release channel gives 26.4**, not 26.6. We switched the channel
(`PATCH /services/{id}` `{"releaseChannel":"fast"}`) and it upgraded 26.2 → 26.4.

That matters because the two headline geo features landed in **26.6** (2026-06-25):

| Feature | Version | On our Cloud (26.4)? |
|---|---|---|
| `GeoJSON` input/output format | 26.6 | ❌ verified absent |
| `MVTEncode` / `MVTEncodeGeom` (`ST_AsMVT`) | 26.6 | ❌ verified absent |
| `h3PolygonToCells` | earlier | ✅ present |
| `readWKB` / `wkb` / `mortonEncode` / `hilbertEncode` | ≤25.7 | ✅ present |

Cloud trails open-source by ~2 releases. **Do not plan on 26.6 landing before 23 July.**

Consequence: **no vector tiles from Cloud.** Build GeoJSON by hand instead
(`toJSONString` + `map()`), which is fine at our scale (3 cities, low-thousands of
POIs) — MapLibre takes a GeoJSON source directly. MVT only matters at 10M+ points.

## ⚠️ Known issue — access-entity replication is currently inconsistent

We ran `CREATE SETTINGS PROFILE` **while the service was mid-upgrade** (probes
returned 26.2 and 26.4 from different replicas at the same moment). Result:

```
CREATE SETTINGS PROFILE p_html → Code: 493 already exists in `replicated`
DROP   SETTINGS PROFILE p_html → Code: 180 There is no settings profile `p_html`
SELECT name FROM system.settings_profiles → p_html not listed
```
And for `web_html2`: `SELECT` *lists* it (storage=`replicated`), but `ALTER SETTINGS
PROFILE` → `Code: 180 There is no settings profile`.

So `p_html` / `web_html` / `web_html2` are wedged. **Lesson: never run access DDL
during a version upgrade.** Fix: pick fresh names once the service is settled, or
raise with ClickHouse support. Not a blocker — the mechanism itself is proven.

## Options for the delivery shape — decide before writing frontend code

**A. Cloud-only (all-in on the stunt).**
`index.html` is a row in `web.pages`; browser fetches it from Cloud; the same page's
JS queries Cloud directly for GeoJSON (CORS is open). Zero infrastructure.
Cost: ugly `/?query=…` URLs, no MVT.

**B. Hybrid.** Cloud = primary DB + data API. A 26.6+ ClickHouse container serves
the app via `http_handlers` (clean URLs, `static_handler`, MVT tiles) and reaches
Cloud through `remoteSecure()`. Cost: a box to run and keep alive through judging
(29 July).

**C. Cloud + Cloudflare.** Bootstrap HTML on Workers/R2, everything else from Cloud.
Safest, least interesting.

Leaning **A**, with a Cloudflare Worker in front purely to give it a pretty hostname
(`wherehouse.slim-shaggy.com` → rewrite to the `?query=` URL). That keeps the claim
literally true — every byte originates from ClickHouse — while being demoable.

**`wherehouse.slim-shaggy.com` is reserved for this and nothing else.** The basemap
briefly squatted on it (18 July) and was moved to `basemap.slim-shaggy.com`, because a
hostname that reads like the product should serve the product. The two are unrelated:
the basemap is static OSM tiles out of R2 with no ClickHouse in the path, whereas this
hostname must serve bytes that originate in a `MergeTree` row. Don't let anything else
take it.

## Why this is defensible, not a gimmick

The rules require ClickHouse as the **primary database**. This goes further: it is
the database, the API, and the web server. For a judge scoring "depth, creativity and
correctness in leveraging ClickHouse", a URL that serves a working map application
straight out of a `MergeTree` is a strong, memorable, 10-second demo beat.

It's also honest — nothing here is faked. `readonly=1` + quotas + a public token is
the same posture ClickHouse ships on `play.clickhouse.com`.
