import { schedules, logger } from "@trigger.dev/sdk";
import { createClient } from "@clickhouse/client";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CITIES, type CityName } from "./scoring";

/**
 * The rest of the autonomous refresh. refresh.ts made the Overture DEMAND layer (buildings /
 * cell_capacity / addr_density / road_density) self-sustaining on a monthly cron; this file does
 * the same for the three remaining pure-loader tables, so the whole request-path dataset — supply,
 * demand-by-population and place names — has a hands-off production refresh, not just a laptop
 * bootstrap. Same honest framing as refresh.ts: Overture and Kontur barely move month-to-month, so
 * the value is ARCHITECTURAL AUTONOMY ("the pipeline sustains itself"), never "the data is fresh".
 *
 * Each task mirrors its bash/SQL bootstrap loader and is idempotent the same way — per-partition
 * DROP + re-INSERT, so a re-run replaces rather than doubles. The bootstraps stay the source of
 * truth for the SQL; these are the scheduled path:
 *
 *   refreshPlaces      <- db/clickhouse/002_places_load.sql   (Overture POI, INSERT..SELECT s3)
 *   refreshPopulation  <- infra/load-population.sh            (Kontur GeoPackage, see below)
 *   refreshDistricts   <- infra/load-districts.sh resolve_sql (Overture divisions, point-in-poly)
 *
 * City bboxes and the Kontur country are NOT re-declared: they come from scoring.ts CITIES, the one
 * box the whole app scores against. If supply were filtered by a different box than it was loaded
 * with, edge cells would see demand with no competitors and score falsely high.
 *
 * Crons are staggered by hour so the four monthly jobs (incl. refresh.ts at 03:00) never contend
 * for the idle-warmed service at once, and refreshDistricts runs AFTER refreshPopulation because it
 * reads geo.population — a same-day monthly run then names cells against the population it just got.
 */

const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_USER,
  password: process.env.CLICKHOUSE_PASSWORD,
  // The client default request_timeout is 30 s; these S3 decode / geometry queries run far past it
  // (the bash loaders use `curl --max-time 300`). Raise it, and turn on progress headers so the
  // ClickHouse Cloud load balancer does not drop an otherwise-idle socket mid-query — the
  // documented long-running-query pattern for @clickhouse/client.
  request_timeout: 600_000,
  clickhouse_settings: {
    max_execution_time: 590,
    send_progress_in_http_headers: 1,
    http_headers_progress_interval_ms: "50000",
  },
});

// Overture release, pinned EXACTLY as the bash loaders and refresh.ts pin it. A silently newer
// release would move POI counts and district names under the demo. Bump here + in the bash loaders
// together to adopt a new release.
const OVERTURE_RELEASE = "2026-06-17.0";
const OVERTURE_BASE = `https://overturemaps-us-west-2.s3.amazonaws.com/release/${OVERTURE_RELEASE}`;
const PLACES = `${OVERTURE_BASE}/theme=places/type=place/*.parquet`;
const DIVISIONS = `${OVERTURE_BASE}/theme=divisions/type=division_area/*.parquet`;

// Kontur Population is its own snapshot with its own pin (see 003_population_schema.sql). Same
// reason: a newer snapshot would move every GAP score's demand term with nobody noticing.
const KONTUR_RELEASE = "20231101";
const KONTUR_BASE =
  "https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets";

type Bbox = (typeof CITIES)[CityName]["bbox"];

// Same helper shape refresh.ts uses: command() for writes, query()+TabSeparatedRaw for scalars.
async function exec(query: string): Promise<void> {
  await clickhouse.command({ query });
}
async function scalar(query: string): Promise<string> {
  const rs = await clickhouse.query({ query, format: "TabSeparatedRaw" });
  return (await rs.text()).trim();
}

// -----------------------------------------------------------------------------------------------
// refreshPlaces — geo.places, the SUPPLY layer. Mirrors db/clickhouse/002_places_load.sql exactly.
// -----------------------------------------------------------------------------------------------

// Filter on bbox.* (float columns → parquet row-group pruning), NEVER on geometry (forces a full
// point decode). geometry.1 is LON, geometry.2 is LAT. h3_8 / h3_9 / mercator_* are MATERIALIZED
// columns computed from lat/lon on insert (001_places_schema.sql), so they are NOT selected here —
// which is also why H3 is only ever computed in a MATERIALIZED column, never inline (the lat-first
// trap is silent otherwise). confidence >= 0.5 strips junk geocodes Overture parks at the curve
// origin (~13% of Berlin); operating_status filters the closed.
const placesSelect = (city: CityName, b: Bbox) => `
  SELECT
    id,
    coalesce(names.primary, '')          AS name,
    coalesce(categories.primary, '')     AS category,
    toFloat32(coalesce(confidence, 0.))  AS confidence,
    geometry.1                           AS lon,
    geometry.2                           AS lat,
    '${city}'                            AS city
  FROM s3('${PLACES}', 'Parquet')
  WHERE bbox.xmin BETWEEN ${b.lonMin} AND ${b.lonMax}
    AND bbox.ymin BETWEEN ${b.latMin} AND ${b.latMax}
    AND coalesce(confidence, 0.) >= 0.5
    AND coalesce(operating_status, 'open') != 'closed'`;

// Smallest real city is Belgrade at ~26k; a floor well under that catches an empty/broken reload
// without being brittle to Overture release drift.
const PLACES_FLOOR = 5_000;

export const refreshPlaces = schedules.task({
  id: "refresh-places",
  // 04:00 UTC on the 1st — one hour after refresh.ts, after the monthly Overture release lands.
  cron: "0 4 1 * *",
  maxDuration: 1200,
  run: async () => {
    const counts: Record<string, number> = {};
    for (const city of Object.keys(CITIES) as CityName[]) {
      const b = CITIES[city].bbox;
      await exec(`ALTER TABLE geo.places DROP PARTITION '${city}'`);
      await exec(
        `INSERT INTO geo.places (id, name, category, confidence, lon, lat, city) ${placesSelect(city, b)}`,
      );
      const n = Number(await scalar(`SELECT count() FROM geo.places WHERE city = '${city}'`));
      logger.info(`refreshed places for ${city}`, { rows: n });
      // Throw mid-loop rather than at the end: a degenerate partition should stop the run, and the
      // already-refreshed cities keep their good data.
      if (n < PLACES_FLOOR) {
        throw new Error(`geo.places '${city}' has ${n} rows (< ${PLACES_FLOOR}) — degenerate reload`);
      }
      counts[city] = n;
    }
    logger.info("places refresh complete", counts);
    return counts;
  },
});

// -----------------------------------------------------------------------------------------------
// refreshPopulation — geo.population (Kontur, H3 res 8). Mirrors infra/load-population.sh.
//
// This is the ONE loader that is not INSERT..SELECT-from-a-queryable-source, and it cannot be:
// Kontur ships a per-country GeoPackage (SQLite + a geometry blob we don't want), and ClickHouse
// has no way to read it — url(...,'RawBLOB') returns the whole gzip as ONE row and Cloud has no
// sqlite table function (both verified live 2026-07-20). So, exactly as the bash loader does, we
// download + gunzip + read (h3, population) with node's built-in sqlite, then stream a TSV
// INSERT..SELECT stringToH3(c1)... FROM input(...) so ClickHouse computes the same UInt64 h3_8 that
// geoToH3 produces for geo.places. Verified identical: stringToH3('881ef5db6dfffff') =
// 0x881ef5db6dfffff = 613034210078228479, so the equality join geo.places.h3_8 = geo.population.h3_8
// holds. Partition is by COUNTRY (DE|NL|RS), not city — Kontur is per-country and several cities can
// share one (none do here, but the loop is country-keyed to match the schema).
//
// NB: node:sqlite is a built-in from Node 22.5+; the deployed Trigger runtime must be >= that.
// -----------------------------------------------------------------------------------------------

// Unique Kontur countries the demo cities need, derived from CITIES — DE, NL, RS.
const COUNTRIES = [...new Set(Object.values(CITIES).map((c) => c.country))];

// Smallest real country is NL at ~51k; a floor under that flags an empty load. The stronger check
// is inserted === table count below (proves the TSV insert dropped nothing).
const POPULATION_FLOOR = 10_000;

async function loadPopulationCountry(cc: string): Promise<number> {
  const gzUrl = `${KONTUR_BASE}/kontur_population_${cc}_${KONTUR_RELEASE}.gpkg.gz`;
  const gpkgPath = join(tmpdir(), `kontur_${cc}_${KONTUR_RELEASE}.gpkg`);

  logger.info(`population ${cc}: downloading ${gzUrl}`);
  const res = await fetch(gzUrl);
  if (!res.ok || !res.body) {
    throw new Error(`population ${cc}: download failed (${res.status})`);
  }
  // Stream the 25 MB (DE) gzip straight to disk through gunzip — never hold both the compressed and
  // decoded GeoPackage in memory. Readable.fromWeb bridges the fetch web stream to node streams.
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    createGunzip(),
    createWriteStream(gpkgPath),
  );

  // population > 0 mirrors dump_tsv's WHERE — empty cells carry no demand signal. h3 stays TEXT
  // here; stringToH3 in the INSERT turns it into the UInt64.
  //
  // node:sqlite is imported DYNAMICALLY, not at module top level: `trigger deploy` indexes every
  // task file by importing it, and a top-level `import "node:sqlite"` would be evaluated in the
  // build/index container — which runs an older Node (the deploy image was node:21.7.3) that lacks
  // node:sqlite (built in from 22.5), failing the whole deploy. Deferring the import to run time
  // keeps the indexer clean; only this task's actual monthly run needs the 22.5+ runtime.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(gpkgPath, { readOnly: true });
  const rows = db
    .prepare("SELECT h3, population FROM population WHERE population > 0")
    .all() as { h3: string; population: number }[];
  db.close();
  logger.info(`population ${cc}: read ${rows.length} populated cells`);
  if (rows.length < POPULATION_FLOOR) {
    throw new Error(`population ${cc}: only ${rows.length} cells (< ${POPULATION_FLOOR}) — bad source`);
  }

  const tsv = rows.map((r) => `${r.h3}\t${r.population}\t${cc}`).join("\n");

  await exec(`ALTER TABLE geo.population DROP PARTITION '${cc}'`);

  // Streamed exactly like the bash loader's `curl --data-binary @-`: the @clickhouse/client insert()
  // targets a table, not an input()+SELECT transform, so this one write goes over raw HTTP. Auth
  // and settings come from the same env the client uses.
  const query =
    "INSERT INTO geo.population (h3_8, population, country) " +
    "SELECT stringToH3(c1), c2, c3 FROM input('c1 String, c2 Float32, c3 String') FORMAT TSV";
  const user = process.env.CLICKHOUSE_USER ?? "default";
  const auth = Buffer.from(`${user}:${process.env.CLICKHOUSE_PASSWORD ?? ""}`).toString("base64");
  const insert = await fetch(`${process.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(query)}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: tsv,
    signal: AbortSignal.timeout(600_000),
  });
  if (!insert.ok) {
    throw new Error(`population ${cc}: insert failed (${insert.status}) ${await insert.text()}`);
  }

  const loaded = Number(await scalar(`SELECT count() FROM geo.population WHERE country = '${cc}'`));
  // The table must hold exactly what we streamed — a mismatch means rows were silently dropped.
  if (loaded !== rows.length) {
    throw new Error(`population ${cc}: loaded ${loaded} != read ${rows.length} — rows dropped`);
  }
  return loaded;
}

export const refreshPopulation = schedules.task({
  id: "refresh-population",
  // 05:00 UTC on the 1st. Kontur is a fixed snapshot, so this re-materialises the same data — the
  // point is autonomy, and it runs before refreshDistricts, which reads this table.
  cron: "0 5 1 * *",
  maxDuration: 1800,
  run: async () => {
    const counts: Record<string, number> = {};
    for (const cc of COUNTRIES) {
      counts[cc] = await loadPopulationCountry(cc);
    }
    logger.info("population refresh complete", counts);
    return counts;
  },
});

// -----------------------------------------------------------------------------------------------
// refreshDistricts — geo.districts, place NAMES. Mirrors infra/load-districts.sh resolve_sql exactly.
//
// All the geometry work happens HERE, once, so the request path is an equality join on h3_8. Three
// load-bearing, live-measured facts (see the bash loader / 005_districts_schema.sql for the full
// story): h3ToGeo returns (lat, lon) so `.1` is LAT and `.2` is LON (swap → zero rows, no error);
// filter Overture divisions on bbox.* with an OVERLAP test, and project the bbox columns explicitly
// (bxmin ...) before the cross join or every cell lands "inside" every district; Overture's geometry
// is a native Variant, so unwrap with variantElement, never readWKB. `argMinIf(..., poly_area, ...)`
// is smallest-containing-polygon-wins (locality polygons nest), and yields '' when a tier matched
// nothing — which IS the contract: no name, never a nearest-guess. names.common['en'] else primary
// renders Belgrade in Latin without transliterating anything ourselves.
// -----------------------------------------------------------------------------------------------

const districtsSelect = (city: CityName, cc: string, b: Bbox) => `
WITH
cells AS (
    SELECT h3_8,
           h3ToGeo(h3_8).2 AS lon,   -- .2 is LON
           h3ToGeo(h3_8).1 AS lat    -- .1 is LAT — the whole H3 family is lat-first
    FROM geo.population
    WHERE country = '${cc}'
      AND h3ToGeo(h3_8).1 BETWEEN ${b.latMin} AND ${b.latMax}
      AND h3ToGeo(h3_8).2 BETWEEN ${b.lonMin} AND ${b.lonMax}
),
div AS (
    SELECT subtype,
           coalesce(nullIf(names.common['en'], ''), assumeNotNull(names.primary)) AS nm,
           geometry,
           bbox.xmin AS bxmin, bbox.xmax AS bxmax,
           bbox.ymin AS bymin, bbox.ymax AS bymax,
           abs(if(variantType(geometry) = 'Polygon',
                  polygonAreaSpherical(variantElement(geometry, 'Polygon')),
                  arraySum(arrayMap(p -> polygonAreaSpherical(p),
                                    variantElement(geometry, 'MultiPolygon'))))) AS poly_area
    FROM s3('${DIVISIONS}')
    WHERE bbox.xmin <= ${b.lonMax} AND bbox.xmax >= ${b.lonMin}
      AND bbox.ymin <= ${b.latMax} AND bbox.ymax >= ${b.latMin}
      AND subtype IN ('macrohood', 'locality')
      AND names.primary IS NOT NULL
),
hit AS (
    SELECT c.h3_8 AS h3_8, d.subtype AS subtype, d.nm AS nm, d.poly_area AS poly_area
    FROM cells c, div d
    WHERE c.lon BETWEEN d.bxmin AND d.bxmax
      AND c.lat BETWEEN d.bymin AND d.bymax
      AND if(variantType(d.geometry) = 'Polygon',
             pointInPolygon((c.lon, c.lat), variantElement(d.geometry, 'Polygon')),
             arrayExists(p -> pointInPolygon((c.lon, c.lat), p),
                         variantElement(d.geometry, 'MultiPolygon')))
)
SELECT h3_8,
       argMinIf(nm, poly_area, subtype = 'macrohood') AS area,
       argMinIf(nm, poly_area, subtype = 'locality')  AS locality,
       '${city}'                                      AS city
FROM hit
GROUP BY h3_8`;

// Smallest real city is Amsterdam at ~739 named cells; a floor under that flags an empty resolve.
const DISTRICTS_FLOOR = 100;

// The three day-3 picks. A loader that reports success while these are WRONG is the exact failure
// this table exists to kill (the model once put all three in Spandau, and the spec repeated it), so
// they are asserted, not printed — see 005_districts_schema.sql. Not a warning: a wrong name is
// worse than no table.
const BERLIN_GROUND_TRUTH: [string, string, string][] = [
  ["881f18b021fffff", "Lichtenrade", "Tempelhof-Schöneberg"],
  ["881f1d4d81fffff", "Biesdorf", "Marzahn-Hellersdorf"],
  ["881f18b645fffff", "Mahlsdorf", "Marzahn-Hellersdorf"],
];

export const refreshDistricts = schedules.task({
  id: "refresh-districts",
  // 06:00 UTC on the 1st — after refreshPopulation (05:00), whose table this reads.
  cron: "0 6 1 * *",
  // The point-in-polygon resolve over every populated cell × every overlapping division is the
  // heaviest query of the three.
  maxDuration: 1800,
  run: async () => {
    const counts: Record<string, number> = {};
    for (const city of Object.keys(CITIES) as CityName[]) {
      const { bbox, country } = CITIES[city];
      await exec(`ALTER TABLE geo.districts DROP PARTITION '${city}'`);
      await exec(
        `INSERT INTO geo.districts (h3_8, area, locality, city) ${districtsSelect(city, country, bbox)}`,
      );
      const n = Number(await scalar(`SELECT count() FROM geo.districts WHERE city = '${city}'`));
      logger.info(`refreshed districts for ${city}`, { rows: n });
      if (n < DISTRICTS_FLOOR) {
        throw new Error(`geo.districts '${city}' has ${n} rows (< ${DISTRICTS_FLOOR}) — degenerate resolve`);
      }
      counts[city] = n;
    }

    // Row counts prove the table is non-empty; they do not prove it is RIGHT. Assert the three
    // known picks resolve to their real names — the falsifier this table was built to be.
    for (const [h3, wantArea, wantLocality] of BERLIN_GROUND_TRUTH) {
      const got = await scalar(
        `SELECT area, locality FROM geo.districts WHERE h3_8 = stringToH3('${h3}') AND city = 'berlin'`,
      );
      if (got !== `${wantArea}\t${wantLocality}`) {
        throw new Error(
          `districts ground truth FAILED for ${h3}: got '${got.replace(/\t/g, ", ")}', want '${wantArea}, ${wantLocality}'`,
        );
      }
    }
    logger.info("districts refresh complete — ground truth holds", counts);
    return counts;
  },
});
