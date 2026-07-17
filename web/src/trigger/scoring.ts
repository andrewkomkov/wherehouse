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
      demand_n * (100 - supply_n) / 100                                   AS gap,
      -- Carried through so choroplethStatsSql can hand the two scalars to the browser, which
      -- re-derives this same score for the re-weight sliders. It must not guess them: a p95
      -- recomputed client-side is a different p95, and the map would drift off the ranking the
      -- agent just gave. See the Scale type in layers.ts.
      -- (No backticks in here — this string is a JS template literal and one would close it.)
      pop_p95, sup_p95
    FROM joined, scale
  )`;
}

/**
 * Total order. The p95 clamp legitimately ties cells at the ceiling (measured: three Berlin
 * cells at exactly 100.0 — the bakery top-3 is *entirely* ties), so without the `cell` tiebreak
 * the "top 3" could reorder between two runs of the same question. (FR-004)
 *
 * Qualified with the `s.` alias because rankSql now LEFT JOINs geo.districts, and `gap`/`pop`
 * would otherwise be ambiguous.
 */
const DETERMINISTIC_ORDER = "ORDER BY s.gap DESC, s.pop DESC, s.cell ASC";

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

/**
 * Cheap stats for the model — never geometry (ADR-001).
 *
 * `popP95`/`supP95` are NOT for the model; they ride out to the browser on the layer part so the
 * sliders can re-derive this exact score without a round-trip (layers.ts `Scale`). `any()` is
 * correct rather than lazy: both are constants of the `scale` CTE, identical on every row.
 */
export function choroplethStatsSql(city: CityName, categories: string[]): string {
  return `WITH ${candidateCells(city, categories)}
  SELECT count() AS cellCount,
         round(max(gap), 1) AS topGap,
         round(median(gap), 1) AS medianGap,
         any(pop_p95) AS popP95,
         any(sup_p95) AS supP95
  FROM scored`;
}

/**
 * The top N picks. Each carries the population and competitor count that produced its score,
 * so a sceptic can recompute the ranking by hand (FR-003) — and now the district name it sits
 * in, so the agent can say "Lichtenrade" without guessing.
 *
 * The LEFT JOIN is the whole fix for day 3's worst bug. Without names in this result the model
 * still wanted to name a place, so it invented one — it put all three Berlin picks in "Spandau",
 * the wrong side of the city. The join is on `h3_8` equality against a table precomputed by
 * infra/load-districts.sh; no geometry runs at request time.
 *
 * **LEFT, and `''` means no name.** Not every cell resolves. Measured coverage 2026-07-20,
 * % of populated cells:
 *
 *     city        locality   area
 *     berlin         98.3    56.8     (its bbox reaches into Brandenburg, where `area` stops)
 *     amsterdam     100.0    47.8
 *     belgrade      100.0     3.9     (Overture has 3 macrohoods for the whole bbox)
 *
 * So `area = ''` is the NORMAL case in Belgrade, not an edge case — see placeName() in chat.ts,
 * which is the single place that decides what an absent name means. An unresolved cell yields
 * `''` and the agent then says nothing — never the nearest district. An INNER JOIN here would
 * silently drop the best cell in Brandenburg from the ranking, a worse lie than saying less.
 *
 * `area`/`locality` are Overture's tiers, not Berlin's: `locality` is a Bezirk inside Berlin but
 * a Gemeinde in Brandenburg, a municipality in NL and a village in RS. Naming these columns
 * `ortsteil`/`bezirk` (the first cut) encoded a Berlin assumption as universal — the same defect
 * class this whole table exists to fix. See db/clickhouse/005_districts_schema.sql.
 */
export function rankSql(city: CityName, categories: string[], limit = 3): string {
  return `WITH ${candidateCells(city, categories)}
  SELECT h3ToString(s.cell)          AS h3,
         round(s.gap, 1)             AS gap,
         round(s.pop)                AS pop,
         s.sup                       AS sup,
         round(h3ToGeo(s.cell).2, 5) AS lon,
         round(h3ToGeo(s.cell).1, 5) AS lat,
         d.area                      AS area,
         d.locality                  AS locality
  FROM scored AS s
  LEFT JOIN geo.districts AS d ON s.cell = d.h3_8 AND d.city = '${city}'
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
