/**
 * The GAP score — defined exactly once, here.
 *
 * `scoreArea` (the choropleth) and `rankSites` (the top 3) must never disagree, so they read
 * the same CTE rather than each carrying a copy that drifts.
 *
 *     gap = demand_n × (100 − supply_n) / 100 × acc_n / 100
 *
 * Deliberately a formula you can explain in one breath to a judge, not a model. Its honesty
 * comes from what goes into it and from stating what it leaves out — not from being clever.
 *
 * The third term is accessibility (residents within a 10-min walk); it is OMITTED, never zeroed,
 * when unmeasured — a cell with no measured catchment scores on the first two terms alone.
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
  acc AS (
    -- Residents reachable on foot in 10 min from the cell's res-9 centre child (D2), against
    -- the real street network. population/7 spreads a res-8 parent evenly over its seven res-9
    -- children — the same granularity the product already ranks on (data-model.md).
    -- geo.isochrone_cells is joined, never drawn; equality on both sides' sort key (D6).
    -- has_acc = toUInt8(1) is the unambiguous 'a row existed' flag: a LEFT JOIN miss below fills
    -- the non-nullable acc_pop with 0, and a real acc of 0.286 exists, so 0 alone is ambiguous.
    SELECT o.h3_8 AS cell, sum(p.population / 7) AS acc_pop, toUInt8(1) AS has_acc
    FROM (SELECT h3_8, h3ToCenterChild(h3_8, 9) AS origin FROM cells) o
    INNER JOIN geo.isochrone_cells ic ON ic.origin_h3_9 = o.origin AND ic.minutes = 10 AND ic.city = '${city}'
    INNER JOIN geo.population p ON p.h3_8 = h3ToParent(ic.reachable_h3_9, 8) AND p.country = '${country}'
    GROUP BY o.h3_8
  ),
  joined AS (
    SELECT c.h3_8 AS cell, c.population AS pop, coalesce(s.n, 0) AS sup,
      a.acc_pop AS acc_pop, coalesce(a.has_acc, 0) AS has_acc
    FROM cells c
    LEFT JOIN supply s ON c.h3_8 = s.cell
    LEFT JOIN acc a ON c.h3_8 = a.cell
  ),
  scale AS (
    -- greatest(..., 1) guards the divide for a category with almost no supply.
    SELECT quantile(0.95)(pop) AS pop_p95, greatest(quantile(0.95)(sup), 1) AS sup_p95,
      -- p95 over MEASURED cells only — the 830 absent Berlin cells must not drag the scale down.
      greatest(quantileIf(0.95)(acc_pop, has_acc = 1), 1) AS acc_p95
    FROM joined
  ),
  scored AS (
    SELECT cell, pop, sup,
      least(100, 100 * pop / pop_p95)                                     AS demand_n,
      least(100, 100 * sup / sup_p95)                                     AS supply_n,
      least(100, 100 * acc_pop / acc_p95)                                 AS acc_n,
      -- Three-term product. When accessibility is absent, if(has_acc, ...) yields 1 so the factor
      -- drops out and the cell scores on the other two exactly as before this feature (D4).
      demand_n * (100 - supply_n) / 100 * if(has_acc, acc_n / 100, 1)     AS gap,
      -- Carried through so choroplethStatsSql can hand the three scalars to the browser, which
      -- re-derives this same score for the re-weight sliders. It must not guess them: a p95
      -- recomputed client-side is a different p95, and the map would drift off the ranking the
      -- agent just gave. See the Scale type in layers.ts. has_acc/acc_pop ride along too so the
      -- stats and choropleth queries can mark absence and print the measured value.
      -- (No backticks in here — this string is a JS template literal and one would close it.)
      pop_p95, sup_p95, acc_p95, has_acc, acc_pop
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
      ',"sup":', toString(sup),
      -- absent != 0: the acc key exists only when the catchment was measured (has_acc=1).
      -- JSON.stringify's rule expressed in SQL — an unmeasured cell has no acc key at all.
      if(has_acc, concat(',"acc":', toString(round(acc_pop))), ''), '}}')), ','),
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
         any(sup_p95) AS supP95,
         any(acc_p95) AS accP95,
         countIf(has_acc = 0) AS notMeasured
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
 *
 * `WHERE s.has_acc = 1` excludes cells whose walk we could not measure. Their `gap` is a
 * two-factor score (the accessibility term drops out), so ranking them against measured cells
 * would compare two different scores — a cell could top the list purely by never being measured.
 * The choropleth still shows them (styled as not-measured); only the ranking omits them.
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
  WHERE s.has_acc = 1
  ${DETERMINISTIC_ORDER}
  LIMIT ${limit}`;
}

/**
 * Neighbourhood-fit for a handful of picks — an EDITORIAL heuristic, never a measurement.
 *
 * ⚠️ This does NOT touch the GAP ranking. GAP stays demand × (100 − supply) × accessibility
 * (candidateCells above); affinity is a SEPARATE, labelled signal shown next to a pick. `weight`
 * is a hand-authored opinion of how much a nearby trade complements `target` (see
 * db/clickhouse/007_affinity.sql). If it ever multiplied into `gap`, an opinion would be
 * laundered into a measurement — the exact failure constitution II names. Keep it out.
 *
 * `target` is the already-resolved category string (the caller maps the user's word via
 * CATEGORY_SYNONYMS in chat.ts; a group with no single target falls back to 'restaurant'). Per
 * pick it returns:
 *   - `fit`: sum over the pick's h3kRing(1) of dictGetFloat32(affinity, (target, place.category))
 *     across the city's places — a footfall-proxy raw sum, deliberately un-normalised (spec.md).
 *   - `topNeighbours`: a JSON array string of the top 3 complementary trades actually present in
 *     the ring, by summed weight, `[{"category","n","w"}]` — only categories with weight > 0.
 *
 * absent != 0: a pick whose ring holds no complementary trade still returns a row (LEFT JOIN from
 * the picks), with `fit` 0 and `topNeighbours` '[]'. That is "we found none nearby", which the
 * caller must render as those words — never as a measured "fit = 0" fact (FR-006).
 *
 * Measured live 2026-07-17 (Cloud 26.4), berlin / bakery, the three real top-3 picks:
 *   881f18b021fffff  fit 10.8  [supermarket ×8, elementary_school ×3, pharmacy ×4]
 *   881f1d4d81fffff  fit  6.2  [supermarket ×6, park ×2, elementary_school ×1]
 *   881f18b563fffff  fit  3.3  [elementary_school ×2, supermarket ×2, coffee_shop ×1]
 */
export function affinityForCellsSql(
  city: CityName,
  category: string,
  h3Strings: string[],
): string {
  const c = city.replace(/'/g, "''");
  const target = category.replace(/'/g, "''");
  const picks = h3Strings.map((h) => `stringToH3('${h.replace(/'/g, "''")}')`).join(", ");

  return `WITH
  picks AS (SELECT arrayJoin([${picks}]) AS pick),
  per_cat AS (
    SELECT r.pick AS pick, pl.category AS category, count() AS n,
           dictGetFloat32('geo.affinity_dict', 'weight', ('${target}', pl.category)) AS w
    FROM (SELECT pick, arrayJoin(h3kRing(pick, 1)) AS cell FROM picks) r
    INNER JOIN geo.places pl ON pl.h3_8 = r.cell AND pl.city = '${c}'
    GROUP BY r.pick, pl.category
  )
  SELECT h3ToString(pk.pick)      AS h3,
         round(sum(pc.n * pc.w), 2) AS fit,
         -- Top 3 complementary trades in the ring, by summed weight (n × w), weight > 0 only.
         -- Built by hand (Cloud 26.4 has no GeoJSON/JSON format); the LEFT-JOIN filler row for a
         -- pick with no matches has w = 0 ⇒ excluded ⇒ '[]', the absent-≠-0 rendering (FR-006).
         concat('[', arrayStringConcat(arrayMap(
           e -> concat('{"category":', toJSONString(e.1),
                       ',"n":', toString(e.2),
                       ',"w":', toString(round(e.3, 2)), '}'),
           arraySlice(arrayReverseSort(e -> e.2 * e.3, groupArrayIf((pc.category, pc.n, pc.w), pc.w > 0)), 1, 3)
         ), ','), ']')            AS topNeighbours
  FROM picks pk
  LEFT JOIN per_cat pc ON pc.pick = pk.pick
  GROUP BY pk.pick
  ORDER BY fit DESC, pk.pick`;
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

/**
 * The saved-site join — this feature's whole point (ADR-004, the OLTP+OLAP story).
 *
 * A user's saved sites (seconds old, replicated from managed Postgres by ClickPipes CDC into
 * `oltp.pg_saved_sites`) re-scored against *today's* market: the same `scored` CTE the choropleth
 * and ranking read, joined on `stringToH3(ss.h3_8) = sc.cell` — H3 equality, no interpolation.
 *
 * The join to `scored` is **LEFT**: a saved site whose h3 sits outside the scored set (e.g. the
 * user pinned a spot past the city bbox) survives with a NULL score and renders "unscored", never
 * 0 — the same absent-≠-0 discipline the accessibility term keeps (FR-006). `if(sc.cell != 0, …)`
 * is the guard: a LEFT JOIN miss leaves `sc.cell` at the H3 zero value, so `market_gap`/`residents`/
 * `rivals` are omitted entirely rather than emitted as 0.
 *
 * `oltp.pg_shortlists` scopes the sites to the requested city (a user's shortlist carries the city;
 * saved sites carry no city of their own). Both `_peerdb_is_deleted = 0` filters are mandatory —
 * CDC keeps tombstones, and without them a deleted site or shortlist reappears.
 *
 * Measured, u1 / berlin / bakery, 2026-07-17: 'Kastanienallee corner' gap 0.0 (3,725 residents,
 * 25 rivals), 'Boxhagener Platz' 18.2 (1,772, 10) — both saturated central sites.
 */
export function savedSitesGeoJsonSql(
  city: CityName,
  categories: string[],
  userId: string,
): string {
  const uid = userId.replace(/'/g, "''");
  const c = city.replace(/'/g, "''");
  return `WITH ${candidateCells(city, categories)}
  SELECT concat('{"type":"FeatureCollection","features":[',
    arrayStringConcat(groupArray(concat(
      '{"type":"Feature","geometry":{"type":"Point","coordinates":[',
      toString(round(ss.lon, 5)), ',', toString(round(ss.lat, 5)),
      ']},"properties":{"label":', toJSONString(ss.label),
      ',"status":', toJSONString(ss.status),
      -- absent != 0 for the saved score too: a site saved before it was scored has score = NULL,
      -- and round(NULL) would collapse the whole feature's concat to NULL and silently drop the
      -- site from the map. Guard it, so a null score omits the key and renders "unscored".
      if(isNotNull(ss.score), concat(',"savedScore":', toString(round(ss.score, 1))), ''),
      -- absent != 0: the market keys exist only when the LEFT JOIN found a scored cell (FR-006).
      -- A site outside the scored set keeps sc.cell at the H3 zero value ⇒ no keys ⇒ "unscored".
      if(sc.cell != 0, concat(
        ',"marketGap":', toString(round(sc.gap, 1)),
        ',"residents":', toString(round(sc.pop)),
        ',"rivals":', toString(sc.sup)), ''),
      '}}')), ','),
    ']}')
  -- FINAL on both CDC tables: they are SharedReplacingMergeTree keyed on _peerdb_version, so an
  -- edited or deleted site can sit as two versions until a background merge. Without FINAL the
  -- older (un-deleted) version can win and a just-deleted site reappears — exactly the freshness
  -- CDC exists to give us. FINAL collapses to the latest version per row before the filter runs.
  FROM oltp.pg_saved_sites AS ss FINAL
  INNER JOIN oltp.pg_shortlists AS sl FINAL ON ss.shortlist_id = sl.id AND sl.city = '${c}'
  LEFT JOIN scored sc ON stringToH3(ss.h3_8) = sc.cell
  WHERE ss._peerdb_is_deleted = 0 AND sl._peerdb_is_deleted = 0 AND ss.user_id = '${uid}'`;
}

/**
 * The same join as `savedSitesGeoJsonSql`, but plain columns for the model's summary — never
 * geometry (ADR-001). `market_gap`/`residents`/`rivals` come back NULL for a site outside the
 * scored set (LEFT JOIN miss); the caller renders that as "unscored", never 0 (FR-006).
 *
 * Measured, u1 / berlin / bakery, 2026-07-17: two rows, market_gap 0.0 and 5.4. (The 5.4 was
 * 18.2 while the score was two-term; feature 002 folded accessibility into the same candidateCells
 * this reuses, so a saved site is now judged against the current three-term market — which is the
 * point of re-scoring it live rather than trusting the score we stored when it was saved.)
 */
export function savedSitesRowsSql(
  city: CityName,
  categories: string[],
  userId: string,
): string {
  const uid = userId.replace(/'/g, "''");
  const c = city.replace(/'/g, "''");
  return `WITH ${candidateCells(city, categories)}
  SELECT ss.label            AS label,
         ss.h3_8             AS h3_8,
         ss.score            AS saved_score,
         round(sc.gap, 1)    AS market_gap,
         sc.pop              AS residents,
         sc.sup              AS rivals,
         ss.status           AS status,
         ss.created_at       AS created_at
  -- FINAL: see savedSitesGeoJsonSql — collapse SharedReplacingMergeTree versions before filtering
  -- so a just-deleted or just-edited site is read at its latest version, not a stale one.
  FROM oltp.pg_saved_sites AS ss FINAL
  INNER JOIN oltp.pg_shortlists AS sl FINAL ON ss.shortlist_id = sl.id AND sl.city = '${c}'
  LEFT JOIN scored sc ON stringToH3(ss.h3_8) = sc.cell
  WHERE ss._peerdb_is_deleted = 0 AND sl._peerdb_is_deleted = 0 AND ss.user_id = '${uid}'
  ORDER BY ss.created_at`;
}

/**
 * The walk catchment of a single pick, as one GeoJSON string — one Feature **per lobe** (D5).
 *
 * `geo.isochrones` stores a multi-lobed contour as several rows on purpose (445 of Berlin's are
 * multi-lobed); collapsing them is how a catchment gets drawn 2 km from the cell it labels. The
 * origin is the pick's res-9 centre child — the SAME rule the score uses (D2), so the drawn shape
 * and the ranked number are one measurement, not two that can disagree.
 *
 * ⚠️ The `geojson` column is emitted **verbatim**. Valhalla emits GeoJSON, GeoJSON is [lon, lat],
 * and it was stored exactly as emitted — so, unlike every H3 path in this file, there is NO
 * coordinate swap here. Do not "tidy" it. A contour is rendered, never joined (data-model.md).
 *
 * Zero rows ⇒ the concat yields an empty features array ⇒ the caller treats the pick as not
 * measured. `pickH3` is the pick's res-8 h3 string, straight from rankSql's `h3ToString`.
 *
 * Measured, Berlin pick #1: 1 lobe, sub-second.
 */
export function catchmentSql(city: CityName, pickH3: string): string {
  const h3 = pickH3.replace(/'/g, "''");
  return `WITH h3ToCenterChild(stringToH3('${h3}'), 9) AS oc
  SELECT concat('{"type":"FeatureCollection","features":[',
    arrayStringConcat(groupArray(concat(
      '{"type":"Feature","geometry":{"type":"Polygon","coordinates":', geojson,
      '},"properties":{"minutes":10,"h3":"${h3}","rank":1}}')), ','),
    ']}')
  FROM geo.isochrones WHERE origin_h3_9 = oc AND minutes = 10 AND city = '${city}'`;
}

/**
 * Cheap stats for the catchment layer — never geometry (ADR-001).
 *
 * `lobes` counts the contour rows (a multi-lobed catchment is several); `reachablePeople` is the
 * same population/7 sum the score's `acc` term uses, so the number under the drawn shape is the
 * number that moved the pick up the ranking. `reachablePeople = 0` with `lobes = 0` means the
 * pick's centre child never routed — the not-measured case. Country resolves from CITIES.
 *
 * Measured, Berlin pick #1 (881f18b021): lobes = 1, reachablePeople = 14,780.
 */
export function catchmentStatsSql(city: CityName, pickH3: string): string {
  const { country } = CITIES[city];
  const h3 = pickH3.replace(/'/g, "''");
  return `WITH h3ToCenterChild(stringToH3('${h3}'), 9) AS oc
  SELECT
    (SELECT count() FROM geo.isochrones
     WHERE origin_h3_9 = oc AND minutes = 10 AND city = '${city}') AS lobes,
    (SELECT round(sum(p.population / 7)) FROM geo.isochrone_cells ic
       INNER JOIN geo.population p ON p.h3_8 = h3ToParent(ic.reachable_h3_9, 8) AND p.country = '${country}'
     WHERE ic.origin_h3_9 = oc AND ic.minutes = 10 AND ic.city = '${city}') AS reachablePeople`;
}

/**
 * Historical momentum for one (city, trade) as a single JSON object — is this market rising, flat,
 * or saturating? The trend the static GAP snapshot cannot see (008_history.sql).
 *
 * ⚠️ RELATIVE momentum from OSM edit history, never an exhaustive absolute count. An OSM count rises
 * for two reasons this data cannot separate: businesses actually opening, and OSM *mapping* catching
 * up. So: recent years only (2022+, where coverage is mature), framed as momentum, cross-validated
 * against our own Overture count (ohsome's 1426 Berlin bakeries vs geo.places' 1460, 2.3% apart,
 * 2026-07-17). The honest pitch is "rising/flat/saturating?", never "always fresh" — a monthly
 * rollup of a slow-moving series, not a live feed. The agent MAY state the trend on those terms.
 *
 * `category` is the already-resolved single target string (the caller maps the user's word via
 * CATEGORY_SYNONYMS in chat.ts, as affinityForCellsSql does). The one-column result is a JSON object
 * the caller parses:
 *   - `direction`: 'rising' | 'flat' | 'saturating', derived from pctChange with a STATED
 *     threshold — rising if > +8, saturating if < -8, else flat. Not asserted (FR-004). The three
 *     Berlin trades the loader checks land on the right side of it: cafe +10.8 (rising),
 *     bakery -5.2 (flat), ev_charging_station +205.9 (rising/booming).
 *   - `pctChange`: round(100 * (last - first) / first, 1) read from geo.category_momentum — the
 *     incremental MV (the ClickHouse showcase), via its argMin/argMax *Merge combinators, NOT
 *     recomputed here. `null` when the divide is undefined (first = 0) or history is too thin.
 *   - `monthly`: the full [{month, count}] series from geo.poi_history, arraySort'd by month (~54
 *     points). Sorted in-array rather than trusting groupArray order, so the sparkline can plot it
 *     as-is.
 *   - `enoughHistory`: false when the series has < 12 months. ABSENT ≠ 0: a trade the loader could
 *     not fetch has no rows at all, so this returns `false` with an empty `monthly` and `null`
 *     pctChange — the caller renders "not enough history", never a fabricated flat-at-zero trend
 *     (FR-005). The momentum subquery has no GROUP BY on purpose, so it yields one all-zero row for
 *     an absent trade rather than no row, keeping the CROSS JOIN — and the result — a single row.
 *
 * Measured live 2026-07-17 (Cloud 26.4): berlin/cafe rising +10.8, bakery flat -5.2,
 * ev_charging_station rising +205.9; an unknown trade → {enoughHistory:false, monthly:[]}.
 */
export function categoryTrendSql(city: CityName, category: string): string {
  const c = city.replace(/'/g, "''");
  const cat = category.replace(/'/g, "''");
  return `SELECT concat(
    '{"direction":', toJSONString(
      -- Stated threshold (FR-004): rising > +8, saturating < -8, else flat. first_count = 0 (an
      -- undefined pct) and a thin series both fall through to 'flat'; enoughHistory below is what
      -- the caller actually gates on, so this stays a valid label either way.
      multiIf(s.n < 12, 'flat', m.first_count = 0, 'flat', pct > 8, 'rising', pct < -8, 'saturating', 'flat')),
    ',"pctChange":', if(s.n >= 12 AND m.first_count > 0, toString(pct), 'null'),
    -- The real start year of the series, so the UI and the model state the true window instead of
    -- a hardcoded "3 years". ohsome data begins 2022, so this is ~2022 — the span is > 3 years and
    -- calling it "3Y" was a false claim (constitution II). Say "since <fromYear>" instead.
    ',"fromYear":', toString(m.from_year),
    ',"enoughHistory":', if(s.n >= 12, 'true', 'false'),
    ',"monthly":[', s.monthly, ']}')
  FROM
  (
    SELECT count() AS n,
      arrayStringConcat(arrayMap(
        e -> concat('{"month":', toJSONString(toString(e.1)), ',"count":', toString(e.2), '}'),
        arraySort(e -> e.1, groupArray((month, count)))
      ), ',') AS monthly
    FROM geo.poi_history
    WHERE city = '${c}' AND category = '${cat}'
  ) AS s
  CROSS JOIN
  (
    -- Read momentum from the incremental MV, not from the raw series (FR-002). No GROUP BY: an
    -- absent trade returns one all-zero row here, so the CROSS JOIN still yields exactly one row.
    SELECT argMinMerge(first_count) AS first_count,
           argMaxMerge(last_count)  AS last_count,
           toYear(minMerge(first_month)) AS from_year,
           round(100 * (last_count - first_count) / nullIf(first_count, 0), 1) AS pct
    FROM geo.category_momentum
    WHERE city = '${c}' AND category = '${cat}'
  ) AS m`;
}
