-- Historical momentum. The table that lets the agent say "cafes here are rising, bakeries are
-- saturated" — a trend the static GAP snapshot cannot see, measured from real OSM edit history.
--
-- Powered by the full OSM edit history via ohsome (HeiGIT): ohsome's /elements/count walks the
-- entire history of every element and returns how many matched the filter at each monthly
-- snapshot. We do NOT re-derive that here — we store the monthly rollup ohsome hands back, one
-- row per (city, category, month), and let a ClickHouse materialized view maintain the momentum.
--
-- ⚠️ THE CONFOUND, STATED NOT HIDDEN (constitution II).
--
-- An OSM count rises for two reasons that this data cannot separate: businesses actually opening,
-- and OSM *mapping* catching up to businesses that were already there. A naive reading — "Berlin
-- gained 1,281 charging stations" — launders the second into the first and is a confident lie.
-- So this signal is RELATIVE momentum over recent years, never an exhaustive absolute count:
--   * Recent years only (2022+), where OSM coverage is already mature. The proof that coverage is
--     no longer the dominant force is in the data itself: Berlin's bakery curve is FLAT-to-down
--     (1504 in 2022-01 → 1426 in 2026-06, -5.2%). If mapping lag still dominated, a well-mapped
--     everyday trade like bakeries could not fall. It is the fast-moving trades (charging stations
--     +206%, cafes +10.8%) that carry real signal against that flat baseline.
--   * The honest pitch is "is this market rising, flat, or saturating?", never "always fresh" or
--     "the complete count of X". It is a slow-moving series on a monthly refresh, not a live feed.
--
-- CROSS-VALIDATION against our own Overture count — a standing check that ohsome and Overture see
-- the same city. Measured live 2026-07-17: ohsome shop=bakery over the Berlin bbox at the latest
-- month (2026-06) = 1426; our geo.places bakery count = 1460. A 2.3% difference between two
-- independent datasets (OSM history vs Overture's snapshot), which is close enough to trust the
-- tag map and far enough to be a real cross-check, not the same number twice. (The spec's earlier
-- "~1%" was an eyeball; 2.3% is what the live query returns, and the measured number is what goes
-- in the doc — constitution II.)
--
-- ABSENT ≠ ZERO. A (city, category) the loader could not fetch (ohsome error, then a retry, then
-- skip) writes NO rows — it does not write a fake 0. So the momentum read below simply returns no
-- row for it, and the consumer renders "not enough history", never a fabricated flat-at-zero
-- trend. Likewise a genuinely tiny history (a couple of months) is real data, but the consumer's
-- direction threshold must treat it as "not enough history" rather than a percentage swing.
--
-- WHAT WAS VERIFIED, 2026-07-17, against the live ohsome API and ClickHouse Cloud (26.4):
--   * ohsome data extent runs to 2026-06-19, so the loader caps the end month at 2026-06-01;
--     asking for 2026-07-01 (today's month) returns HTTP 404 "not within the timeframe".
--   * Berlin monthly, 2022-01 → 2026-06 (P1M, 54 points): cafe 2427 → 2689 (+10.8%),
--     charging_station 622 → 1903 (+205.9%), bakery 1504 → 1426 (-5.2%). These are the three the
--     loader asserts (rising / booming / flat).
--
-- Load with infra/load-history.sh (it applies this file, loads all 18 categories × 3 cities from
-- ohsome, then asserts the three Berlin momenta above).
--
-- ---------------------------------------------------------------------------------------
-- WHY THE MV USES ONLY IDEMPOTENT AGGREGATES (argMin / argMax / min / max)
-- ---------------------------------------------------------------------------------------
-- The loader re-runs by DROP PARTITION on geo.poi_history per city, then re-INSERT. But DROP
-- PARTITION on the raw table does NOT un-write the aggregate states this MV already pushed into
-- geo.category_momentum — a materialized view is a trigger on INSERT, it has no delete hook. So a
-- re-run APPENDS a fresh set of states next to the old ones, and correctness depends entirely on
-- the merge being idempotent under duplicate states:
--   argMinMerge over two identical argMinStates → the same (first month, first count).
--   argMaxMerge / minMerge / maxMerge → likewise.
-- Every aggregate here has that property, so re-loading is safe and needs no manual cleanup of the
-- MV target. A SUM or COUNT here would double on every reload — do not add one.
--
-- Momentum read (first → last percentage change per city, category):
--   SELECT city, category,
--          argMinMerge(first_count) AS f, argMaxMerge(last_count) AS l,
--          minMerge(first_month)    AS fm, maxMerge(last_month)   AS lm,
--          round(100 * (l - f) / f, 1) AS pct_change   -- nullIf(f, 0) if a series can start at 0
--   FROM geo.category_momentum GROUP BY city, category;

CREATE DATABASE IF NOT EXISTS geo;

-- The raw monthly series. One row per (city, category, month); count is the number of OSM elements
-- matching the trade's tag at that monthly snapshot. This is the loader's INSERT target and the
-- MV's source. Partitioned by city so a reload is DROP PARTITION per city (see header for why the
-- MV target survives that, and why that is fine).
CREATE TABLE IF NOT EXISTS geo.poi_history
(
    city     LowCardinality(String),   -- berlin | amsterdam | belgrade
    category LowCardinality(String),   -- Overture category name (bakery, cafe, ...), NOT the OSM tag
    month    Date,                      -- first day of the snapshot month (ohsome timestamp[:10])
    count    UInt32                     -- elements matching the OSM tag at that snapshot
)
ENGINE = MergeTree
PARTITION BY city
ORDER BY (city, category, month);

-- The momentum store, maintained incrementally by the MV below. Holds, per (city, category), the
-- aggregate states needed to read first/last count and first/last month with the *Merge
-- combinators. AggregatingMergeTree so states for the same key collapse on merge.
CREATE TABLE IF NOT EXISTS geo.category_momentum
(
    city        LowCardinality(String),
    category    LowCardinality(String),
    first_count AggregateFunction(argMin, UInt32, Date),   -- count at the earliest month
    last_count  AggregateFunction(argMax, UInt32, Date),   -- count at the latest month
    first_month AggregateFunction(min, Date),
    last_month  AggregateFunction(max, Date)
)
ENGINE = AggregatingMergeTree
ORDER BY (city, category);

-- The showcase: an incremental materialized view. Every INSERT into poi_history flows through this
-- and updates the momentum store — a monthly refresh needs no recompute of history, only the new
-- rows. Created with IF NOT EXISTS and never dropped on apply, so applying this file over a loaded
-- database does not blow away the momentum. It MUST exist before the loader inserts, or the first
-- load's rows never reach category_momentum; infra/load-history.sh applies this file first.
CREATE MATERIALIZED VIEW IF NOT EXISTS geo.category_momentum_mv
TO geo.category_momentum AS
SELECT city,
       category,
       argMinState(count, month) AS first_count,
       argMaxState(count, month) AS last_count,
       minState(month)           AS first_month,
       maxState(month)           AS last_month
FROM geo.poi_history
GROUP BY city, category;
