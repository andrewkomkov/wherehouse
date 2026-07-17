-- OLAP side: the POI corpus the whole site-selection answer is computed from.
-- Overture Maps places, narrowed to the three demo cities. Source of truth is public
-- parquet on S3 (ADR-002); this table is the demo-time copy an agent turn actually hits
-- (S3 at 1-4 s is fine for a batch load, not for an interactive turn).
--
-- ClickHouse Cloud 26.4.1.2029 (`fast` channel), eu-west-1.
-- Load with 002_places_load.sql.

CREATE DATABASE IF NOT EXISTS geo;

CREATE TABLE IF NOT EXISTS geo.places
(
    id         String,                  -- Overture GERS id, stable across releases
    name       String,                  -- names.primary; '' when Overture has none
    category   LowCardinality(String),  -- categories.primary; '' for ~6.5% of rows (see below)
    confidence Float32,                 -- 0-1, Overture's own belief the place exists
    lon        Float64,                 -- Overture geometry.1
    lat        Float64,                 -- Overture geometry.2
    city       LowCardinality(String),  -- berlin | amsterdam | belgrade

    ---------------------------------------------------------------------------
    -- H3. MATERIALIZED is not a style choice — it is the mitigation for the trap.
    --
    -- geoToH3 is (lat, lon). Every other ClickHouse geo function is (lon, lat).
    -- Getting it backwards is SILENT: counts stay plausible, cells land in the
    -- Indian Ocean. We shipped that bug once already. Defining it exactly once,
    -- here, means no query can get it wrong. Never call geoToH3 inline.
    --
    -- Verified on the loaded data 2026-07-17: h3ToGeo(h3_8) round-trips to within
    -- 528 m for Berlin / 515 m Amsterdam / 556 m Belgrade (res-8 cell edge ~460 m),
    -- and h3_9 to within ~200 m — the expected sqrt(7) = 2.65x tightening.
    -- The flipped form would instead give (13.402, 52.520): open ocean off Somalia.
    ---------------------------------------------------------------------------
    h3_8 UInt64 MATERIALIZED geoToH3(lat, lon, 8),  -- choropleth / density unit
    h3_9 UInt64 MATERIALIZED geoToH3(lat, lon, 9),  -- isochrone snapping (h3PolygonToCells)

    -- Web-mercator pixel coords, the ClickHouse-idiomatic spatial index. This is the
    -- pattern ClickHouse ships for Foursquare places (100M POIs).
    mercator_x UInt32 MATERIALIZED 0xFFFFFFFF * ((lon + 180) / 360),
    mercator_y UInt32 MATERIALIZED 0xFFFFFFFF * ((1 / 2) - ((log(tan(((lat + 90) / 360) * pi())) / pi()) / 2)),

    INDEX idx_x    mercator_x TYPE minmax       GRANULARITY 1,
    INDEX idx_y    mercator_y TYPE minmax       GRANULARITY 1,
    INDEX idx_h3_8 h3_8       TYPE bloom_filter GRANULARITY 1,  -- WHERE h3_8 IN h3kRing(...)
    INDEX idx_h3_9 h3_9       TYPE bloom_filter GRANULARITY 1,
    INDEX idx_cat  category   TYPE set(0)       GRANULARITY 1
)
ENGINE = MergeTree
-- Three cities are geographically disjoint, so partitioning by city gives exact
-- pruning for free and makes a per-city reload a DROP PARTITION instead of a rebuild.
PARTITION BY city
-- Morton interleaves x/y into one key, so a bbox or tile scan stays contiguous on disk.
-- H3 columns then give O(1) equality joins on top. There is no R-tree in ClickHouse.
ORDER BY mortonEncode(mercator_x, mercator_y);
