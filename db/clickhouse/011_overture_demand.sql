-- The Overture built-environment demand layer — three signals the raw Kontur headcount cannot
-- express, all read straight from Overture parquet on public S3 (ADR-002), all joined to
-- geo.population / geo.places on h3_8 EQUALITY with no interpolation.
--
-- WHY THIS EXISTS
--
-- geo.population (Kontur) answers "how many people live in this cell today". That is one axis of
-- demand. It cannot answer three others a site-selection agent actually needs:
--
--   * CAPACITY  — a cell of six-storey residential blocks holds far more customers than the same
--                 footprint of allotments, even at equal current population. Built floor-area is
--                 the proxy. (geo.buildings + geo.cell_capacity)
--   * OCCUPANCY — address (door) count per cell is a units-of-premises demand signal that
--                 complements a headcount. (geo.addr_density)
--   * FRONTAGE  — retail viability and walkability track street density: metres of pedestrian way
--                 vs vehicular road per cell. (geo.road_density)
--
-- Source: Overture Maps, release 2026-06-17.0, public S3 (us-west-2), queried in place with s3().
-- Overture buildings/addresses/transportation blend OSM (ODbL) with open government sources.
-- Attribution is required wherever the map shows them — see web/src/components/attribution.tsx.
--
-- TRAPS (each verified live against the service, constitution II):
--   * The H3 family is LAT-FIRST: geoToH3(lat, lon, res). Overture geometry is (lon, lat), so a
--     Point is geometry.1=lon / geometry.2=lat and the call is geoToH3(geometry.2, geometry.1, 8).
--     Swapping them lands cells in the Indian Ocean with NO error. H3 lives only in MATERIALIZED
--     columns here for exactly that reason.
--   * Filter Overture on bbox.* (plain floats -> Parquet row-group pruning), NEVER on geometry.
--   * geometry arrives as a native Geometry Variant, not WKB: use variantElement(geometry,
--     'Polygon'|'MultiPolygon'), never readWKB (ILLEGAL_TYPE_OF_ARGUMENT).
--   * polygonAreaSpherical returns STERADIANS and its sign follows ring winding: always
--     abs(...) * 6371007.18^2 for m2.
--
-- Loaded by infra/load-overture-demand.sh (per-city DROP PARTITION + INSERT, idempotent).

CREATE DATABASE IF NOT EXISTS geo;

-- ---------------------------------------------------------------------------------------------
-- geo.buildings — one row per Overture building footprint across the three cities (~1.57M rows,
-- measured: Berlin 890,984 / Amsterdam 365,847 / Belgrade 316,598). The volume centrepiece: real
-- Overture data materialised, not an s3()-in-place scan, because the per-cell capacity rollup
-- needs only h3_8 + area + floors and precomputing turns a per-request geometry decode into an
-- indexed equality join (~47 MB on disk, measured 31.5 bytes/row).
--
-- `lon`/`lat` are the footprint's bbox centroid — accurate to a few tens of metres at res-8, and
-- the only cheap centroid available without decoding the polygon a second time at read.
-- `area_m2` is decoded ONCE here (spherical area of the footprint polygon), so the read path
-- never touches geometry. `height`/`num_floors` are Overture's own, and both are sparsely filled
-- (measured Berlin: height 53.7 %, num_floors 24.1 %) — see geo.cell_capacity for how the
-- capacity proxy degrades gracefully rather than pretending they are complete.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo.buildings
(
    `id`         String,
    `city`       LowCardinality(String),
    -- bbox centroid; the H3 columns are derived from these, LAT-FIRST.
    `lon`        Float64,
    `lat`        Float64,
    `height`     Nullable(Float64),
    `num_floors` Nullable(Int32),
    `area_m2`    Float64,
    -- '' when Overture has no subtype (measured Berlin: 53.4 % NULL). Never a fabricated class.
    `subtype`    LowCardinality(String),
    `h3_8`       UInt64 MATERIALIZED geoToH3(lat, lon, 8),
    `h3_9`       UInt64 MATERIALIZED geoToH3(lat, lon, 9)
)
ENGINE = MergeTree
PARTITION BY city
ORDER BY h3_8;

-- ---------------------------------------------------------------------------------------------
-- geo.cell_capacity + geo.cell_capacity_mv — the incremental per-cell built-capacity rollup.
--
-- THIS is where a materialized view earns its place (the showcase the volume flex is for): an
-- AggregatingMergeTree MV rolling ~1.57M raw footprints into one capacity number per res-8 cell,
-- updated incrementally as buildings load — no full recompute. Read with sumMerge/countMerge.
--
-- The capacity proxy is floor-area = footprint_area * storeys, with storeys taken from
-- num_floors, falling back to height/3 (a ~3 m storey), falling back to 1. Because num_floors is
-- only ~24 % filled this is an ESTIMATE for RELATIVE ranking between cells, never a survey — a
-- cell twice another's floor-area can hold roughly twice the demand; the absolute m2 is not a
-- headcount. (constitution II — stated as the estimate it is.)
--
-- ⚠️ RELOAD SAFETY. sumState/countState are NOT idempotent (unlike the argMin/argMax/min/max in
-- 008_history.sql), so re-inserting a city would DOUBLE its capacity. The loader therefore drops
-- this table's city partition too, before re-inserting geo.buildings — hence PARTITION BY city
-- here, so cell_capacity and buildings drop in lockstep. Do not remove the partitioning.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo.cell_capacity
(
    `city`          LowCardinality(String),
    `h3_8`          UInt64,
    `floor_area_m2` AggregateFunction(sum, Float64),
    `buildings`     AggregateFunction(count)
)
ENGINE = AggregatingMergeTree
PARTITION BY city
ORDER BY (city, h3_8);

CREATE MATERIALIZED VIEW IF NOT EXISTS geo.cell_capacity_mv TO geo.cell_capacity AS
SELECT
    city,
    -- Recomputed from lon/lat in the MV rather than read from the MATERIALIZED h3_8 column, so the
    -- rollup never depends on whether the source's materialized columns are visible to the trigger.
    geoToH3(lat, lon, 8) AS h3_8,
    sumState(area_m2 * coalesce(toFloat64(num_floors), height / 3, 1.0)) AS floor_area_m2,
    countState()                                                         AS buildings
FROM geo.buildings
GROUP BY city, h3_8;

-- ---------------------------------------------------------------------------------------------
-- geo.addr_density — Overture address (door) count per res-8 cell. A premises-density demand
-- proxy that complements a headcount: people vs. units. (~1.51M addresses scanned, aggregated to
-- ~2-3k cells/city; measured Berlin 542,542 addresses over 2,129 cells, max 1,005/cell.)
--
-- ⚠️ Address COVERAGE is uneven across countries (measured: Amsterdam 741k > Berlin 542k despite
-- being smaller — NL open-address coverage is exceptional). So this is a WITHIN-city signal
-- (rank/percentile a city against itself); raw counts must never be compared city-to-city.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo.addr_density
(
    `city`       LowCardinality(String),
    `h3_8`       UInt64,
    `addr_count` UInt32
)
ENGINE = MergeTree
PARTITION BY city
ORDER BY (city, h3_8);

-- ---------------------------------------------------------------------------------------------
-- geo.road_density — street frontage per res-8 cell, split walkable vs. vehicular from Overture's
-- `class`. A retail-viability / walkability signal. (~583k segments; measured Berlin 391,336
-- road-subtype segments over 2,663 cells.)
--
-- ⚠️ `road_len_m`/`walk_len_m` are the sum of each segment's BBOX DIAGONAL, not its true polyline
-- length, and a segment is assigned WHOLE to its bbox-centroid cell. That is a deliberate density
-- approximation (acceptable at res-8, ~461 m edge), NOT survey-grade metres of frontage — a long
-- curved or cell-spanning segment is over/under-counted. Use for relative density, not exact km.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo.road_density
(
    `city`       LowCardinality(String),
    `h3_8`       UInt64,
    `seg_count`  UInt32,
    `road_len_m` Float64,
    `walk_len_m` Float64
)
ENGINE = MergeTree
PARTITION BY city
ORDER BY (city, h3_8);
