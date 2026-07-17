-- Demand. The other half of the GAP score, and the half we could not compute before.
--
-- geo.places tells us where the SUPPLY is (1,460 bakeries in Berlin). It says nothing
-- about how many people live there, and Overture has no population layer at all. Without
-- this table "demand" can only be proxied by the density of other POIs — "lots of offices
-- here" is not "lots of customers here", and an investor would rightly reject that.
--
-- Kontur Population is the fix, and it fits us almost suspiciously well: it is published
-- natively on **H3 res 8**, which is already our choropleth unit. No interpolation, no
-- raster sampling, no spatial join — geo.places.h3_8 = geo.population.h3_8 is an equality
-- join on the sort key of both tables.
--
-- Source:  https://data.humdata.org/dataset/kontur-population-<country>  (per-country)
-- Release: 20231101. Licence: CC BY 4.0 — attribution is REQUIRED in the UI, see below.
-- Built from GHSL + Facebook HRSL + Microsoft Buildings + Copernicus + OSM.
--
-- Verified on load (2026-07-17), by two independent checks rather than by trusting it:
--   * totals land on reality — DE 83.53M vs ~83.2M real (+0.4%), NL 17.85M vs ~17.8M
--     (+0.3%), RS 7.18M vs ~6.7M (+7.2%; Kontur's Serbian extent is more generous than
--     the usual figure. Fine for a demand proxy, but don't quote it as a census).
--   * our own hex resolves — the saved site at Kastanienallee is h3_8 881f1d4881fffff,
--     which Kontur has at 3,725 people. Dense inner Prenzlauer Berg. Plausible.
--
-- CAVEAT worth stating out loud when the map is shown: this is a **2023-11-01 snapshot**.
-- People move slower than shops open, so it is the stable half of the score — but it is
-- not live, and ADR-004's freshness story is about saved sites, not about this.
--
-- Load with infra/load-population.sh (the source is GeoPackage, i.e. SQLite, so the
-- loader reads it with plain sqlite3 — no GDAL dependency).

CREATE DATABASE IF NOT EXISTS geo;

CREATE TABLE IF NOT EXISTS geo.population
(
    -- Kontur ships h3 as text ('881f1d4881fffff'); stringToH3 makes it the same UInt64
    -- geoToH3 produces in geo.places. Verified identical for a known cell.
    h3_8       UInt64,
    population Float32,                 -- people in this ~0.7 km2 cell, Kontur's estimate
    country    LowCardinality(String)   -- DE | NL | RS
)
ENGINE = MergeTree
-- Reloading one country is a DROP PARTITION, not a rebuild. Only 475k rows total, so
-- this is about operational sanity rather than performance.
PARTITION BY country
-- Same sort key as the join predicate, so the merge join degenerates to a scan-free
-- lookup against geo.places.h3_8.
ORDER BY h3_8;
