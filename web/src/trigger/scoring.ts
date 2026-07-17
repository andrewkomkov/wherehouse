/**
 * The GAP score — defined exactly once, here.
 *
 * `scoreArea` (the choropleth) and `rankSites` (the top 3) must never disagree, so they read
 * the same CTE rather than each carrying a copy that drifts.
 *
 *     gap = demand_n × (100 − supply_n) / 100
 *
 * Deliberately a formula you can explain in one breath to a judge, not a model. Its honesty
 * comes from what goes into it and from stating what it leaves out — not from being clever.
 */

/** Bounding box, not an administrative boundary. */
type City = {
  bbox: { latMin: number; latMax: number; lonMin: number; lonMax: number };
  /** Kontur partitions population by country. */
  country: "DE" | "NL" | "RS";
};

/**
 * These are **exactly** the bboxes geo.places was loaded with (db/clickhouse/002_places_load.sql
 * lines 41-84). They are copied, not re-derived: if demand were filtered by a different box
 * than supply was loaded with, cells near the edge would see population with no competitors
 * and score falsely high. Change one, change both.
 *
 * Berlin's box holds 4.25M people against ~3.6M in the city proper — it reaches into
 * Brandenburg. Fine for ranking (surrounding cells compete on the same terms), but the
 * population total is NOT a census figure and must not be quoted as one.
 */
export const CITIES = {
  berlin: {
    bbox: { latMin: 52.338, latMax: 52.675, lonMin: 13.088, lonMax: 13.761 },
    country: "DE",
  },
  amsterdam: {
    bbox: { latMin: 52.27, latMax: 52.44, lonMin: 4.68, lonMax: 5.07 },
    country: "NL",
  },
  belgrade: {
    bbox: { latMin: 44.66, latMax: 44.92, lonMin: 20.2, lonMax: 20.65 },
    country: "RS",
  },
} as const satisfies Record<string, City>;

export type CityName = keyof typeof CITIES;

export const isCity = (c: string): c is CityName => c in CITIES;

/**
 * The candidate-cell CTE. Returns `cell`, `pop`, `sup`, `gap` per populated H3 res-8 cell.
 *
 * Two things here were measured rather than assumed, and both are load-bearing:
 *
 * 1. **Supply reads a ring, not a cell.** A competitor 100 m away across a hex boundary is
 *    competition. Cell-local supply finds a bakery in 514 Berlin cells; the k=1 ring finds
 *    one in 1,354. (FR-006)
 *
 * 2. **There is no saturation constant.** The inherited "3 bakeries = saturated" sits at the
 *    p75 of a distribution that runs to 64 — it would flatten a third of Berlin into "fully
 *    saturated" and degenerate the score into "wherever the most people live". Both terms are
 *    instead scaled by their own p95, re-derived per city and category at query time, so
 *    there is no magic number to defend. p95 rather than max so one outlier cannot compress
 *    the rest of the city. (FR-007, FR-010)
 *
 * ⚠️ `h3ToGeo` returns **(lat, lon)** — `.1` is LATITUDE. The whole H3 family is lat-first
 * while every other ClickHouse geo function is lon-first. Swap these and the bbox matches
 * nothing: **zero rows, no error, an empty map**. Do not "tidy" this.
 */
function candidateCells(city: CityName, categories: string[]): string {
  const { bbox, country } = CITIES[city];
  const catList = categories.map((c) => `'${c.replace(/'/g, "''")}'`).join(", ");

  return `
  cells AS (
    SELECT h3_8, population
    FROM geo.population
    WHERE country = '${country}'
      AND h3ToGeo(h3_8).1 BETWEEN ${bbox.latMin} AND ${bbox.latMax}
      AND h3ToGeo(h3_8).2 BETWEEN ${bbox.lonMin} AND ${bbox.lonMax}
  ),
  supply AS (
    SELECT arrayJoin(h3kRing(h3_8, 1)) AS cell, count() AS n
    FROM geo.places
    WHERE city = '${city}' AND category IN (${catList})
    GROUP BY cell
  ),
  joined AS (
    SELECT c.h3_8 AS cell, c.population AS pop, coalesce(s.n, 0) AS sup
    FROM cells c LEFT JOIN supply s ON c.h3_8 = s.cell
  ),
  scale AS (
    -- greatest(..., 1) guards the divide for a category with almost no supply.
    SELECT quantile(0.95)(pop) AS pop_p95, greatest(quantile(0.95)(sup), 1) AS sup_p95
    FROM joined
  ),
  scored AS (
    SELECT cell, pop, sup,
      least(100, 100 * pop / pop_p95)                                     AS demand_n,
      least(100, 100 * sup / sup_p95)                                     AS supply_n,
      demand_n * (100 - supply_n) / 100                                   AS gap
    FROM joined, scale
  )`;
}

/**
 * Total order. The p95 clamp legitimately ties cells at the ceiling (measured: three Berlin
 * cells at exactly 100.0), so without the `cell` tiebreak the "top 3" could reorder between
 * two runs of the same question. (FR-004)
 */
const DETERMINISTIC_ORDER = "ORDER BY gap DESC, pop DESC, cell ASC";

/**
 * The opportunity choropleth as one GeoJSON string, assembled in SQL.
 *
 * Built by hand because Cloud is 26.4 and the `GeoJSON` format needs 26.6 (verified absent;
 * Cloud trails OSS ~2 releases, so it will not arrive before the deadline).
 *
 * ⚠️ `h3ToGeoBoundary` also returns (lat, lon), and GeoJSON wants [lon, lat] — hence the
 * `v.2, v.1` swap on every vertex. The ring is closed by repeating the first vertex.
 *
 * Measured, Berlin bakeries: 2,260 cells · 700 ms · 549 KiB ⇒ always the handle path.
 */
export function choroplethSql(city: CityName, categories: string[]): string {
  return `WITH ${candidateCells(city, categories)}
  SELECT concat('{"type":"FeatureCollection","features":[',
    arrayStringConcat(groupArray(concat(
      '{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[',
      arrayStringConcat(arrayMap(
        v -> concat('[', toString(round(v.2, 5)), ',', toString(round(v.1, 5)), ']'),
        arrayPushBack(h3ToGeoBoundary(cell), h3ToGeoBoundary(cell)[1])
      ), ','),
      ']]},"properties":{"gap":', toString(round(gap, 1)),
      ',"pop":', toString(round(pop)),
      ',"sup":', toString(sup), '}}')), ','),
    ']}')
  FROM scored`;
}

/** Cheap stats for the model — never geometry (ADR-001). */
export function choroplethStatsSql(city: CityName, categories: string[]): string {
  return `WITH ${candidateCells(city, categories)}
  SELECT count() AS cellCount,
         round(max(gap), 1) AS topGap,
         round(median(gap), 1) AS medianGap
  FROM scored`;
}

/**
 * The top N picks. Each carries the population and competitor count that produced its score,
 * so a sceptic can recompute the ranking by hand (FR-003).
 */
export function rankSql(city: CityName, categories: string[], limit = 3): string {
  return `WITH ${candidateCells(city, categories)}
  SELECT h3ToString(cell)          AS h3,
         round(gap, 1)             AS gap,
         round(pop)                AS pop,
         sup                       AS sup,
         round(h3ToGeo(cell).2, 5) AS lon,
         round(h3ToGeo(cell).1, 5) AS lat
  FROM scored
  ${DETERMINISTIC_ORDER}
  LIMIT ${limit}`;
}

/**
 * Competitor points as one GeoJSON string.
 *
 * Measured, Berlin bakeries: 1,460 rows · 430 ms · 175 KiB ⇒ inline. Berlin food & drink is
 * 1.27 MiB and every Berlin POI is 14.9 MiB ⇒ handle. `emitLayer` decides on measured bytes,
 * so nothing here needs to care.
 */
export function competitorsSql(city: CityName, categories: string[]): string {
  const catList = categories.map((c) => `'${c.replace(/'/g, "''")}'`).join(", ");
  return `SELECT concat('{"type":"FeatureCollection","features":[',
    arrayStringConcat(groupArray(concat(
      '{"type":"Feature","geometry":{"type":"Point","coordinates":[',
      toString(round(lon, 5)), ',', toString(round(lat, 5)),
      ']},"properties":{"n":', toJSONString(name), '}}')), ','),
    ']}')
  FROM geo.places
  WHERE city = '${city}' AND category IN (${catList})`;
}

/** Bounding box of a category in a city, for the map to fly to. */
export function bboxSql(city: CityName, categories: string[]): string {
  const catList = categories.map((c) => `'${c.replace(/'/g, "''")}'`).join(", ");
  return `SELECT min(lon) AS minLon, min(lat) AS minLat, max(lon) AS maxLon, max(lat) AS maxLat
  FROM geo.places
  WHERE city = '${city}' AND category IN (${catList})`;
}
