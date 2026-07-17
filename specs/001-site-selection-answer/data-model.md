# Phase 1 — Data model

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

Two of the three entities already exist and are loaded. Only `web.layers` is new. The
important property of this model is that **demand and supply meet on an equality join** —
`geo.places.h3_8 = geo.population.h3_8`, no interpolation, no raster sampling, no spatial
join. That is what makes the score honest rather than a guess, and it is luck we should not
squander: Kontur publishes natively at H3 res 8, which is already our choropleth unit.

## Existing — `geo.places` (211,818 rows, loaded, verified)

Overture POIs for the three demo cities. Full definition in
[`db/clickhouse/001_places_schema.sql`](../../db/clickhouse/001_places_schema.sql).

| Field | Type | Note |
|---|---|---|
| `id` | String | Overture GERS id |
| `name` | String | `''` when Overture has none |
| `category` | LowCardinality(String) | `''` for ~6.5% of rows |
| `lon`, `lat` | Float64 | Overture `geometry.1`, `geometry.2` |
| `city` | LowCardinality(String) | partition key: `berlin \| amsterdam \| belgrade` |
| `h3_8` | UInt64 **MATERIALIZED** | `geoToH3(lat, lon, 8)` — the scoring/choropleth unit |
| `h3_9` | UInt64 **MATERIALIZED** | reserved for day-4 isochrone snapping |

**Never compute H3 inline.** The column exists precisely so no query can get the lat/lon
order wrong — the failure is silent (trap #1).

**Used by**: `findCompetitors` (dots), `scoreArea`/`rankSites` (ring supply).

## Existing — `geo.population` (475,535 rows, loaded, verified)

Kontur Population, release 2023-11-01, **CC BY 4.0 — attribution required in the UI**
(FR-017). Full definition in
[`db/clickhouse/003_population_schema.sql`](../../db/clickhouse/003_population_schema.sql).

| Field | Type | Note |
|---|---|---|
| `h3_8` | UInt64 | joins `geo.places.h3_8` on **equality** |
| `population` | Float32 | people in this ~0.7 km² cell |
| `country` | LowCardinality(String) | partition key: `DE \| NL \| RS` |

**Used by**: `scoreArea`, `rankSites` (the demand term).

## New — `web.layers` (the by-reference store)

Holds layers too large for the stream. Lives in `web` **deliberately**: `site` already holds
`GRANT SELECT ON web.*`, a wildcard that covers new tables, so this needs **zero access DDL**
— which is what keeps it clear of trap #4 (`p_html`/`web_html`/`web_html2` are permanently
wedged from access DDL run during an upgrade). Verified by canary (R2).

| Field | Type | Note |
|---|---|---|
| `id` | String | the handle — random, unguessable, generated per emission |
| `body` | String | the complete GeoJSON FeatureCollection |
| `created_at` | DateTime DEFAULT `now()` | TTL anchor |

```sql
ENGINE = MergeTree ORDER BY id
TTL created_at + INTERVAL 1 HOUR      -- FR-015; verified accepted on CREATE
```

**Written by**: the Trigger.dev task as `default` (INSERT, 770 ms for 549 KiB).
**Read by**: the browser as `site` (readonly=1, GET, 550 ms). Round-trip verified
byte-identical.

**Not a cache.** A row is written once and read once or twice within seconds; the TTL exists
so a week of demos does not accumulate. Do not add lookups, invalidation, or reuse logic —
that is a store nobody asked for.

## Derived — the candidate cell *(not a table; the shape of the scoring query)*

Computed per question, never materialized. Definition lives once, in
`web/src/trigger/scoring.ts`, shared by `scoreArea` and `rankSites`.

| Field | Derivation |
|---|---|
| `cell` | `geo.population.h3_8`, filtered to the city bbox |
| `pop` | `geo.population.population` |
| `sup` | competitors over `h3kRing(h3_8, 1)` — the cell **plus its six neighbours** (FR-006) |
| `demand_n` | `least(100, 100 * pop / p95(pop))` |
| `supply_n` | `least(100, 100 * sup / greatest(p95(sup), 1))` |
| `gap` | `demand_n * (100 - supply_n) / 100` (FR-008) |

**Validation rules**

- Both scaling percentiles are computed **from the current query's candidate set**, so they
  re-derive per city and per category. No constant is stored anywhere (FR-007, FR-010).
- `greatest(p95(sup), 1)` guards division by zero for a category with almost no supply — the
  spec's first edge case.
- Ordering is `gap DESC, pop DESC, cell ASC`: a total order, so the p95 clamp's legitimate
  ties (measured: 3 cells at exactly 100.0) cannot reorder between runs (FR-004).

**Measured shape, Berlin bakeries**: 2,260 candidate cells · 4.25M people · ring supply
median 1 / p95 24 / **max 64** · 700 ms.

## City extents

Bounding boxes, not administrative boundaries. Berlin's bbox holds 4.25M people against
~3.6M in the city proper — it reaches into Brandenburg. Fine for ranking (surrounding cells
compete on the same terms), but **the population total is not a census figure and must never
be quoted as one**.

⚠️ **The bbox filter is where the new trap lives.** `h3ToGeo(h3)` returns **`(lat, lon)`** —
`.1` is latitude. Swapping the tuple elements returns **zero rows with no error**: an empty
map, not a crash. This bit the first draft of the scoring query.

```sql
WHERE h3ToGeo(h3_8).1 BETWEEN <lat_min> AND <lat_max>   -- .1 is LAT
  AND h3ToGeo(h3_8).2 BETWEEN <lon_min> AND <lon_max>   -- .2 is LON
```
</content>
