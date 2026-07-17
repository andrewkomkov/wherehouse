# Research digest — 2026-07-17 (day 1 of 7)

Everything below is either **verified against our own service** or sourced from docs
with a link. Where a claim is unverified it says so. Five research agents produced
this; the empirical checks were run against `i69bqvgz9q.eu-west-1.aws.clickhouse.cloud`.

---

## 1. The brief, decoded

**Theme: "Beyond the Wall of Text."** Build a chat agent where *the response itself is
the product* — visual, interactive, explorable. Judging lens, verbatim: *"ratio of
insight to words. Text is the garnish, not the meal."*

**Scoring:** Use of ClickHouse & Trigger.dev 25% · Problem Fit 20% · Technical
Implementation 20% · Innovation 20% · Scalability & Impact 10% · Presentation 5%.
Bonus category: **best OLTP + OLAP integration** (own prize).

**Hard rules that shape the build:**
- ClickHouse must be the **primary database**. "Postgres managed by ClickHouse" is
  called out as an *optional addition* — that's a broad hint at ClickPipes/PeerDB CDC,
  and it lines up exactly with the OLTP+OLAP bonus.
- Must use Trigger.dev's **`chat.agent()`** specifically. Superficial inclusion = not
  considered.
- Repo **public** under MIT/Apache-2.0 **by the deadline**. All code written inside the
  window (opened 17 Jul 09:00 CET).
- Deadline **23 July 00:00 AoE**, server-enforced. Demo video ≤5 min, open on the
  product, skip the intro.

---

## 2. Trigger.dev `chat.agent()` — the mechanism that wins the theme

GA in **v4.5.0 (2 July 2026)** — three weeks old. Almost certainly why it's mandated.

One conversation = one long-lived durable task keyed on `chatId`, surviving refreshes,
disconnects, redeploys and crashes (CRIU/Firecracker checkpointing; in-memory state
persists across turns). Not `retry` — use `oomMachine`.

**The key capability: custom typed parts.**

```ts
chat.response.write({ type: "data-map", id: "competitors", data: { points } });
```

- arrives client-side in `message.parts`, typed via `UIMessage<unknown, MyData, MyTools>`
- **same `id` → updates that part in place** ⇒ progressive/live-updating visuals
- `transient: true` → UI-only, never persisted (progress chrome)
- non-transient parts persist ⇒ **the map survives a refresh**

Frontend uses `useChat` from `@ai-sdk/react` + `useTriggerChatTransport` — **no API
route needed**; the transport handles SSE, auth refresh, reconnect, Last-Event-ID resume.

**Context hygiene (critical):** tool returns `{ rowCount }` to the model, full GeoJSON
goes to the UI via `chat.response.write`. Never stream 40k points through the LLM.
Trigger.dev calls this the `large-payloads` pattern.

**Gotcha:** tools must be declared on the **agent config** (`tools:`), not only passed
to `streamText` — otherwise `toModelOutput` runs on turn 1 and is silently skipped after.

Auth: backend `TRIGGER_SECRET_KEY`; frontend gets short-lived scoped public tokens via
`auth.createPublicToken({ scopes: { read: { sessions: chatId } } })`.

**We supply the LLM key** (verified 17 Jul). Trigger.dev provides **no** hosted model, AI
gateway, or bundled LLM credits — it's orchestration; the model comes from the Vercel AI
SDK with our own provider key. **Hackathon credits don't cover inference**: $400 is
ClickHouse, $100 is Trigger.dev *compute* (task runs). LLM tokens bill to us — a few
dollars for a demo week, but `ANTHROPIC_API_KEY` must exist before day 2 or the skeleton
stalls at step one.

Useful: their dashboard has a **Models** page — model catalogue with per-1M-token pricing,
plus a "Your models" tab showing our own usage, cost and **cache-hit** sparklines. That's
observability, not provisioning — but it's a good demo beat (show the judges what an answer
actually costs) and it confirms prompt caching is tracked.

`chat.headStart` cuts time-to-first-chunk ~2.8s → ~1.2s. Worth it for demo feel.

Docs: [ai-chat/reference](https://trigger.dev/docs/ai-chat/reference) ·
[tools](https://trigger.dev/docs/ai-chat/tools) ·
[large-payloads](https://trigger.dev/docs/ai-chat/patterns/large-payloads) ·
[v4.5.0 changelog](https://trigger.dev/changelog/v4-5-0)

---

## 3. ClickHouse geospatial — what we actually have

Our service: **26.4** (`fast` channel), eu-west-1.

**Present and verified:** full H3 set (45 fns) incl. `h3PolygonToCells`; `pointInPolygon`;
`geoDistance` (WGS-84 ellipsoid — prefer over `greatCircleDistance`); polygon set ops
(`polygonsIntersectionSpherical` etc.); `readWKT*`/`readWKB*`/`wkt()`/`wkb()`;
`mortonEncode`/`hilbertEncode`; S2; geohash; `flipCoordinates`.

**Absent on 26.4 (need 26.6):** `GeoJSON` format, `MVTEncode`/`ST_AsMVT`.

### ⚠️ The three traps

1. **`geoToH3(lat, lon, res)` is LAT-FIRST** — the only geo function that flips.
   Everything else is `(lon, lat)`. `h3ToGeo` also returns `(lat, lon)`.
   **We already shipped this bug once** (see ADR-002). It fails *silently*: cell counts
   look plausible, hexes land in the Indian Ocean.
   → Mitigation: only ever compute H3 in a `MATERIALIZED` column.

2. **`polygonAreaSpherical` returns steradians and its sign depends on ring winding.**
   Always `abs()`, then `× 6371007.18²` for m². Overture/OSM/Valhalla winding is inconsistent.

3. **Polygon dictionaries: `Polygon` is not a valid key type.** Use
   `Array(Array(Array(Tuple(Float64,Float64))))` (i.e. `MultiPolygon`).
   Undocumented defaults from source: `MAX_DEPTH = 5`, `MIN_INTERSECTIONS = 1` —
   depth 5 is shallow for dense boundaries.

### Indexing — the idiomatic pattern is Morton, not H3

This is what ClickHouse ships for [Foursquare places](https://clickhouse.com/docs/getting-started/example-datasets/foursquare-places) (100M POIs, 42 s load, 11 GB):

```sql
ORDER BY mortonEncode(mercator_x, mercator_y)
INDEX idx_x mercator_x TYPE minmax GRANULARITY 1
```
Morton gives spatial locality for bbox/tile scans; `minmax` prunes granules; H3 columns
give O(1) equality joins for radius queries (`WHERE h3_8 IN h3kRing(…)`).
Benchmarks: H3 k-ring 0.006 s vs bbox scan 0.074 s on 10M rows (ClickHouse); ~12× on
10M (Altinity). There is **no R-tree**; ad-hoc spatial joins remain a real gap.

Best source: [State of Geospatial in ClickHouse (Mar 2026)](https://clickhouse.com/blog/state-of-geospatial-march-2026).
Ignore [marksblogg's GIS critique](https://tech.marksblogg.com/clickhouse-gis-rust.html) — 2023, its WKB/GeoJSON complaints are fixed.

---

## 4. Data — Overture, not OSM PBF

**There is no OSM dataset in ClickHouse docs or the playground** (verified: playground
has only `cell_towers`, `trips`, `opensky`). ClickHouse cannot read `.pbf`.

**Use Overture Maps.** Public S3, no credentials, GeoParquet ⇒ `geometry` arrives as a
native `Point`. Current release **`2026-06-17.0`** — releases rotate, enumerate them.

Measured on our service (eu-west-1 → bucket in us-west-2), **no local copy**:
- Berlin category histogram: **4.0 s** → cafe 2158 · restaurant 1896 · supermarket 1670 · bakery 1545 · hotel 1492
- Berlin bakery H3 density: **1.1 s**
- Amsterdam cafes 663 · Belgrade cafes 881

**Filter on `bbox.*`, never on `geometry`** — `bbox` is plain floats so Parquet
row-group stats prune nearly everything; filtering `geometry` forces a full decode.

Useful columns: `confidence` (0–1, real quality signal — filter `> 0.5`),
`categories.primary`, `names.primary`, `addresses[]`, `websites[]`, `socials[]`,
`brand.wikidata`, `operating_status`.

Known dirt: junk geocodes clustered at the space-filling-curve origin (a Thai cafe at
`-156,-77`). The bbox filter removes them.

Alternative: Foursquare places (100M, official ClickHouse doc page) — richer categories
but geometry is WKB `String`, no GeoParquet typing.

---

## 5. Routing / isochrones — ClickHouse has none

Confirmed: **zero** routing, isochrone, network or graph functions. Valhalla or OSRM
must run alongside (OSRM has no isochrone endpoint → **Valhalla**).

The bridge is clean anyway:
1. Valhalla `/isochrone` → GeoJSON polygons
2. **`h3PolygonToCells(polygon, 8)` → cell set**, then `WHERE h3_8 IN (…)`
   — turns an expensive geometric predicate into an **indexed equality lookup**. This is
   the key move. Far better than per-row `pointInPolygon`.
3. Fixed catchments → load into a `POLYGON_INDEX_CELL` dictionary, `dictGet`.

On 26.6+ you'd pipe GeoJSON straight in/out; on our 26.4 parse via
`JSONExtract(…, 'Array(Array(Array(Float64)))')::Polygon` (verified working by the agent).

### Reusable from `opengridworks-CMS` (the neighbouring project)

It already runs Valhalla, and its hard-won config is worth lifting verbatim:
- `ghcr.io/gis-ops/docker-valhalla/valhalla:latest`, PBF dropped into `/custom_files`
- **`server_threads: "1"`** — multithreaded tile build reliably segfaults
- **`max_time_contour` must be ≥ 480** or an 8h contour errors 151
- `sources_to_targets` caps at ~400 km → pre-filter by haversine
- `tools/indices/isochrones.py`, `indices/api/valhalla.py` (67 lines, stdlib, best-effort)
- `dem-proxy/nginx.conf` — generic caching proxy for AWS terrain tiles, copy verbatim
- `web/index.html` `recolorAtdi()` — **client-side re-weighting** via a MapLibre
  `interpolate` expression + `setPaintProperty`, zero server round-trip. Directly the
  pattern we want for interactive site-selection sliders.
- `porgis` scoring skeleton: 0..100-normalised components → weighted sum → per-feature
  factor scores → choropleth. The **GAP formula** `demand × (100 − supply) / 100` is the
  single most transferable idea in that repo.
- Honesty pattern worth stealing: `reach_source: "valhalla" | "mixed" | "proxy"` —
  the API reports its own data provenance. In a chat agent, "how do you know that?" is
  the whole game.

Not reusable: all Arctic-tourism formulas/weights (half are flagged in-repo as
unratified hypotheses), Russian data sources, hardcoded host paths.

---

## 6. Basemap — Protomaps PMTiles on R2

Measured with `pmtiles extract --dry-run` against the live planet (136.8 GB):

| extract | zooms | size | time |
|---|---|---|---|
| Berlin metro | z0–14 | **31 MB** | 5.8 s |
| Berlin metro | z0–15 | 80 MB | — |
| Germany | z0–14 | 3.4 GB | — |

Three cities at z0–14 ≈ **<100 MB total**. R2 egress is free; a ranged GET = 1 Class B
op ($0.36/M).

```bash
pmtiles extract https://build.protomaps.com/20260716.pmtiles berlin.pmtiles \
  --bbox=13.088,52.338,13.761,52.675 --maxzoom=14 --download-threads=8
```
**Don't hardcode a build date** — `build.protomaps.com/YYYYMMDD.pmtiles` dailies expire
after ~a week.

**Serve via the Protomaps Worker on a custom domain — not `r2.dev`, not bare R2:**
- `r2.dev` is rate-limited and **uncached** (docs: "development purposes" only)
- Cache API is **inert on `*.workers.dev`** — custom domain required or every tile
  re-reads R2
- Bare R2 + CDN gzip **corrupts range requests** (malformed 206, zero-byte body) — this
  broke MapLibre's own demo site ([demotiles#35](https://github.com/maplibre/demotiles/issues/35))
- `.pmtiles` is **not** in Cloudflare's default-cached extension list ⇒ explicit Cache Rule needed

Versions: `pmtiles@4.4.1` · `@protomaps/basemaps@5.7.2` · `maplibre-gl@5.24.0`.
v5 unified the style API: `layers(source, namedFlavor("dark"), { lang: "en" })`.
Assets: `https://protomaps.github.io/basemaps-assets/{fonts,sprites/v4}/…`.

We have `slim-shaggy.com` in Cloudflare already.

---

## 7. ClickHouse as the web server — see ADR-003

Short version: **proven working on Cloud.** `http_response_headers` is a session
setting, so Cloud honours it despite having no `config.xml`. A page stored in a
`MergeTree` row is served as real `text/html` over a plain GET. CORS is open by
default. A `readonly=1` user with quotas is genuinely un-escapable.

Cloud limits: no `http_handlers` (⇒ `/?query=…` URLs only), no anonymous users, no
plaintext passwords, and `readonly=1` forces `http_response_headers` into a SETTINGS
PROFILE (⇒ one user per content-type).

Self-managed 26.6+ additionally gives `static_handler`, clean URLs, and MVT tiles from
SQL. Full detail, including the security profile and the access-entity bug we hit, in
[ADR-003](../architecture/clickhouse-as-webserver.md).

---

## 8. Open questions

- **OLTP+OLAP bonus:** the rules' "Postgres managed by ClickHouse" hint points at
  ClickPipes Postgres CDC. Cheapest credible story: chat sessions / saved sites /
  user actions live in Postgres (OLTP), CDC into ClickHouse (OLAP), and the agent
  queries both. Needs scoping — is it worth the day it costs?
- **Where does Valhalla run?** It needs a graph built from a PBF (GBs) — genuinely
  awkward to make serverless. Options: precompute isochrones for all candidate cells
  offline via a Trigger.dev batch task and store them in ClickHouse (⇒ no runtime
  Valhalla at all, and it makes Trigger.dev orchestration meaningful), vs. a live
  container (Fly.io / Cloudflare Containers / nettop) for arbitrary user-clicked points.
  Precompute-first is probably the right call for a 6-day clock.
- **`mcpEnabled: false`** on our service — ClickHouse Cloud has an MCP server toggle.
  Worth enabling? Judges are ClickHouse engineers; MCP is their own AI story.
- Whether Cloud's `fast` channel reaches 26.6 before 23 July. **Assume not.**
