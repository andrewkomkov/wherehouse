# ADR-002: Overture Maps on S3 as the POI source, queried in place

**Status:** verified live against our own service, 2026-07-17
**Date:** 2026-07-17

## Context

We need POIs (cafes, bakeries, pharmacies, clinics, schools…) plus competitor
locations for Berlin, Amsterdam and Belgrade. The obvious path is OSM: download a
Geofabrik `.osm.pbf`, run osmium/osm2pgsql, transform, load. That is a day of work
and a pile of glue code — on a 6-day clock.

## Decision

Skip OSM PBF ingestion entirely. Use **Overture Maps** parquet on public S3, read
by ClickHouse's `s3()` table function.

Overture is the Linux Foundation POI dataset built from OSM + Meta + Microsoft +
TomTom. It ships as partitioned parquet on `s3://overturemaps-us-west-2`, publicly
readable, no credentials.

**Current release: `2026-06-17.0`.** Releases rotate — enumerate them, never hardcode:

```bash
curl -s "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&delimiter=/&prefix=release/" \
  | grep -o '<Prefix>release/[^<]*</Prefix>' | sed 's/<[^>]*>//g'
```

## Why this is a good fit for ClickHouse specifically

The schema lands in ClickHouse with **`geometry` already typed as native `Point`** —
no WKT parsing, no conversion step. And there's a `bbox` tuple per row, so a
bounding-box predicate prunes parquet row-groups before they're read.

```sql
DESCRIBE s3('https://overturemaps-us-west-2.s3.amazonaws.com/release/2026-06-17.0/theme=places/type=place/*.parquet', 'Parquet')
```

Useful columns: `geometry Point`, `bbox Tuple(xmin,xmax,ymin,ymax)`,
`categories.primary`, `names.primary`, `confidence Float64`, `addresses[]`,
`websites[]`, `socials[]`, `phones[]`, `brand.wikidata`, `operating_status`.

`confidence` and `socials` matter: they let us weight a POI by how sure Overture is
it exists, and hint at digital footprint.

## Measured, on our service (eu-west-1 → bucket in us-west-2)

Category histogram for the Berlin bbox — **4.0 s**, cold, no local copy:

```sql
SELECT categories.primary AS cat, count() AS n
FROM s3('.../theme=places/type=place/*.parquet', 'Parquet')
WHERE bbox.xmin BETWEEN 13.088 AND 13.761
  AND bbox.ymin BETWEEN 52.338 AND 52.675
GROUP BY cat ORDER BY n DESC
```
→ cafe 2158 · restaurant 1896 · supermarket 1670 · bakery 1545 · hotel 1492 · dentist 1691

H3 density of bakeries in Berlin — **1.1 s**:

```sql
SELECT geoToH3(geometry.1, geometry.2, 8) AS h3, count() AS n
FROM s3('.../theme=places/type=place/*.parquet', 'Parquet')
WHERE bbox.xmin BETWEEN 13.088 AND 13.761
  AND bbox.ymin BETWEEN 52.338 AND 52.675
  AND categories.primary = 'bakery'
GROUP BY h3 ORDER BY n DESC
```

Note `geometry.1` = lon, `geometry.2` = lat (tuple access on `Point`).

## Consequences

- **Demo-time queries hit a local MergeTree, not S3.** One-off
  `INSERT INTO places SELECT … FROM s3(…)` for the three city bboxes, `ORDER BY`
  an H3 cell for spatial locality. S3 at 1–4 s is fine for a batch load and great
  for a "watch it ingest live" moment, but not for an interactive agent turn.
- Keeping the `s3()` path working *as well* is a deliberate demo asset: showing a
  judge a live query against the global 60M-row planet parquet, answering in
  seconds, is a strong "meaningful use of ClickHouse" beat.
- Licence: Overture is ODbL/CDLA depending on theme — attribution required in the
  UI. OSM attribution string goes in the MapLibre control regardless.
- Basemap tiles are a *separate* concern from POI data — those come from Protomaps
  PMTiles (see ADR-003), also OSM-derived.
