#!/usr/bin/env bash
# Resolve every populated H3 res-8 cell to a real district name, so the agent can name a place
# instead of inventing one. See db/clickhouse/005_districts_schema.sql for why this exists —
# the short version is that the model put all three Berlin picks in "Spandau", and our own spec
# then made the identical mistake in prose.
#
# All the geometry work happens HERE, once. The request path does an equality join on h3_8 and
# never touches a polygon.
#
# Idempotent: each city is replaced via DROP PARTITION, so re-running is safe.
#
#   ./infra/load-districts.sh          # apply schema + resolve + verify
#   ./infra/load-districts.sh verify   # verification only, no writes

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# shellcheck source=lib.sh
source infra/lib.sh
load_env

: "${CLICKHOUSE_URL:?missing in .env}"
: "${CLICKHOUSE_PASSWORD:?missing in .env}"

# `ch` and `apply_sql_file` live in infra/lib.sh — shared with load-population.sh / load-layers.sh.

# Overture release. Pinned deliberately, exactly as Kontur is in load-population.sh: division
# boundaries move (Overture rotates releases monthly), and a silently newer release would move
# place names under the demo with nobody noticing. Enumerate available releases with:
#   curl -s "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&delimiter=/&prefix=release/"
RELEASE="2026-06-17.0"
DIVISIONS="https://overturemaps-us-west-2.s3.amazonaws.com/release/$RELEASE/theme=divisions/type=division_area/*.parquet"

# city:country:latMin:latMax:lonMin:lonMax
#
# These bboxes are COPIED from web/src/trigger/scoring.ts CITIES, which in turn copied them from
# db/clickhouse/002_places_load.sql. They must match exactly — they are the boxes geo.places and
# geo.population are filtered by, so a cell that can be scored must also be nameable. Change one,
# change all three.
CITIES=(
    "berlin:DE:52.338:52.675:13.088:13.761"
    "amsterdam:NL:52.27:52.44:4.68:5.07"
    "belgrade:RS:44.66:44.92:20.2:20.65"
)

# The resolution query, shared by load and by the dry-run coverage report.
#
# Three things in here are load-bearing and were each measured against the live service:
#
#  1. ⚠️ `h3ToGeo` returns **(lat, lon)** — `.1` is LATITUDE. The whole H3 family is lat-first
#     while every other ClickHouse geo function is lon-first. Swapping these returns ZERO ROWS
#     WITH NO ERROR, which looks like "Overture has no coverage" rather than like a bug.
#
#  2. **Filter Overture on `bbox.*`, never on `geometry`.** bbox is plain floats, so Parquet
#     row-group stats prune almost everything; filtering geometry forces a full decode. The
#     predicate is an OVERLAP test (xmin <= lonMax AND xmax >= lonMin), not containment — a
#     district larger than the city box still has to be found.
#
#  3. **Project the bbox columns explicitly in the subquery** (`bbox.xmin AS bxmin`, ...) before
#     joining. A naive CROSS JOIN of cells x divisions that reaches into `d.bbox.xmin` inside the
#     WHERE gave garbage — every cell "inside" every district. Aliased first, it is correct.
#     The bbox prefilter is also what makes pointInPolygon sub-second instead of a full cross
#     product: it runs on ~4k cells x ~250 divisions only where the boxes actually overlap.
#
# `argMinIf(nm, poly_area, subtype=...)` is the smallest-containing-polygon-wins rule: locality
# polygons nest (Blankenfelde 12.28 km2 inside Blankenfelde-Mahlow 54.95 km2), so a point can be
# in two, and picking arbitrarily is how you end up asserting Brandenburg's Wilmersdorf when you
# meant Berlin's. argMinIf also yields '' when a tier matched nothing, which IS the contract:
# no name, never a nearest-guess.
#
# ⚠️ `polygonAreaSpherical` returns steradians and its sign follows ring winding — hence abs().
# Only the ordering matters here, but the abs() still does.
#
# `poly_area` is the polygon's SIZE (the tiebreak). `area` is the output COLUMN holding the
# fine-grained name. They are deliberately not the same word — an earlier cut called both `area`
# and the tiebreak silently ordered by the wrong thing.
#
# NAME CHOICE: `names.common['en']` when present, else `names.primary`. Measured 2026-07-20 —
# Berlin 0/233 divisions carry an 'en' variant and Amsterdam 0/56 differ from primary, so this
# CANNOT move Lichtenrade or Tempelhof-Schöneberg. All 56 Belgrade divisions carry one and all 56
# differ (Обреновац -> Obrenovac), which is the entire point: an English-language demo for an
# international jury renders Zvezdara rather than Звездара. This READS a field Overture ships; it
# does not transliterate anything ourselves, so the name still comes from the data.
resolve_sql() {
    local city="$1" cc="$2" lat_min="$3" lat_max="$4" lon_min="$5" lon_max="$6"
    cat <<SQL
WITH
cells AS (
    SELECT h3_8,
           h3ToGeo(h3_8).2 AS lon,   -- .2 is LON
           h3ToGeo(h3_8).1 AS lat    -- .1 is LAT — see note 1 above
    FROM geo.population
    WHERE country = '$cc'
      AND h3ToGeo(h3_8).1 BETWEEN $lat_min AND $lat_max
      AND h3ToGeo(h3_8).2 BETWEEN $lon_min AND $lon_max
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
    FROM s3('$DIVISIONS')
    WHERE bbox.xmin <= $lon_max AND bbox.xmax >= $lon_min
      AND bbox.ymin <= $lat_max AND bbox.ymax >= $lat_min
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
       '$city'                                        AS city
FROM hit
GROUP BY h3_8
SQL
}

load_city() {
    local spec="$1"
    local city cc lat_min lat_max lon_min lon_max
    IFS=: read -r city cc lat_min lat_max lon_min lon_max <<<"$spec"

    log "$city: replacing partition"
    ch "ALTER TABLE geo.districts DROP PARTITION '$city'" >/dev/null

    log "$city: resolving cells against Overture divisions ($RELEASE)"
    ch "INSERT INTO geo.districts (h3_8, area, locality, city)
        $(resolve_sql "$city" "$cc" "$lat_min" "$lat_max" "$lon_min" "$lon_max")" >/dev/null

    ok "$city: $(ch "SELECT count() FROM geo.districts WHERE city='$city'") cells named"
}

# The three day-3 picks. These are the whole reason the table exists, so they are asserted, not
# printed for a human to skim. A loader that reports success while the names are wrong is the
# failure mode we are here to kill (constitution II).
GROUND_TRUTH=(
    "881f18b021fffff:Lichtenrade:Tempelhof-Schöneberg"
    "881f1d4d81fffff:Biesdorf:Marzahn-Hellersdorf"
    "881f18b645fffff:Mahlsdorf:Marzahn-Hellersdorf"
)

verify_ground_truth() {
    log "ground truth: the three day-3 picks must resolve to their real names"
    local spec h3 want_a want_l got_a got_l failed=0
    for spec in "${GROUND_TRUTH[@]}"; do
        IFS=: read -r h3 want_a want_l <<<"$spec"
        got_a="$(ch "SELECT area     FROM geo.districts WHERE h3_8 = stringToH3('$h3') FORMAT RawBLOB")"
        got_l="$(ch "SELECT locality FROM geo.districts WHERE h3_8 = stringToH3('$h3') FORMAT RawBLOB")"
        if [[ "$got_a" == "$want_a" && "$got_l" == "$want_l" ]]; then
            ok "  $h3 -> $got_a, $got_l"
        else
            warn "  $h3 -> got '${got_a:-<none>}', '${got_l:-<none>}' — want '$want_a', '$want_l'"
            failed=1
        fi
    done
    # Not a warning. If this table names places wrongly it is worse than not existing: the map
    # would still be right and the sentence would be a confident lie, which is exactly what
    # happened on day 3.
    [[ "$failed" -eq 0 ]] || die "ground truth FAILED — the agent must not be given these names"
}

# Coverage is reported, not asserted, because a gap here is honest: Overture has no macrohood
# over most of Belgrade (3 polygons for the whole bbox), and Berlin's bbox reaches into
# Brandenburg where the Ortsteil tier simply stops. An unnamed cell yields '' and the agent says
# nothing. What must never happen is a cell being given the name of an area it is not in — that
# is what verify_ground_truth is for.
#
# Measured 2026-07-20 (locality/area): berlin 98.3/56.8, amsterdam 100/47.8, belgrade 100/3.9.
# Belgrade's 3.9% means locality-only is the NORMAL path there, not a degraded one.
verify_coverage() {
    echo
    log "coverage: what fraction of populated cells actually got a name?"
    ch "
    SELECT p.city                                                        AS city,
           p.n                                                           AS populated_cells,
           round(100 * countIf(d.locality != '') / p.n, 1)               AS pct_with_locality,
           round(100 * countIf(d.area     != '') / p.n, 1)               AS pct_with_area,
           countIf(d.area = '' AND d.locality = '')                      AS with_no_name_at_all
    FROM geo.districts AS d
    INNER JOIN (
        SELECT 'berlin' AS city, count() AS n FROM geo.population
          WHERE country='DE' AND h3ToGeo(h3_8).1 BETWEEN 52.338 AND 52.675
            AND h3ToGeo(h3_8).2 BETWEEN 13.088 AND 13.761
        UNION ALL
        SELECT 'amsterdam', count() FROM geo.population
          WHERE country='NL' AND h3ToGeo(h3_8).1 BETWEEN 52.27 AND 52.44
            AND h3ToGeo(h3_8).2 BETWEEN 4.68 AND 5.07
        UNION ALL
        SELECT 'belgrade', count() FROM geo.population
          WHERE country='RS' AND h3ToGeo(h3_8).1 BETWEEN 44.66 AND 44.92
            AND h3ToGeo(h3_8).2 BETWEEN 20.2 AND 20.65
    ) AS p ON d.city = p.city
    GROUP BY p.city, p.n ORDER BY city FORMAT PrettyCompactMonoBlock"
}

# The product's actual query shape: does the join rankSql performs return real names for the
# real top-3? Proving the table has rows in it proves nothing.
verify_join() {
    echo
    log "the join rankSql will do: top 3 Berlin bakery cells, named"
    ch "
    WITH
    cells AS (
        SELECT h3_8, population FROM geo.population
        WHERE country='DE' AND h3ToGeo(h3_8).1 BETWEEN 52.338 AND 52.675
          AND h3ToGeo(h3_8).2 BETWEEN 13.088 AND 13.761
    ),
    supply AS (
        SELECT arrayJoin(h3kRing(h3_8, 1)) AS cell, count() AS n
        FROM geo.places WHERE city='berlin' AND category IN ('bakery') GROUP BY cell
    ),
    joined AS (
        SELECT c.h3_8 AS cell, c.population AS pop, coalesce(s.n, 0) AS sup
        FROM cells c LEFT JOIN supply s ON c.h3_8 = s.cell
    ),
    scale AS (
        SELECT quantile(0.95)(pop) AS pop_p95, greatest(quantile(0.95)(sup), 1) AS sup_p95 FROM joined
    ),
    scored AS (
        SELECT cell, pop, sup,
               least(100, 100 * pop / pop_p95) AS demand_n,
               least(100, 100 * sup / sup_p95) AS supply_n,
               demand_n * (100 - supply_n) / 100 AS gap
        FROM joined, scale
    )
    SELECT h3ToString(s.cell)     AS h3,
           round(s.gap, 1)        AS gap,
           d.area                 AS area,
           d.locality             AS locality
    FROM scored AS s
    LEFT JOIN geo.districts AS d ON s.cell = d.h3_8 AND d.city = 'berlin'
    ORDER BY gap DESC, pop DESC, cell ASC
    LIMIT 3 FORMAT PrettyCompactMonoBlock"
}

# Belgrade is the case the column rename exists for: `area` is 3.9%, so the answer there is
# normally locality-only. Printed so the locality-only path is SEEN to read naturally rather than
# assumed to — "Zvezdara" must look like an answer, not like a half-filled row.
verify_belgrade_reads_naturally() {
    echo
    log "belgrade: the locality-only path (area is 3.9% — this is the normal case there)"
    # NB: build the composed name from the RAW columns, then alias for display. Aliasing
    # `if(area='','(none)',area) AS area` first makes ClickHouse substitute the alias back into
    # the arrayFilter, so the composed name came out as "(none), Kovilovo" — a check that lied
    # about the very path it was added to prove. Mirrors placeName() in web/src/trigger/chat.ts.
    ch "
    SELECT h3ToString(h3_8)                                       AS h3,
           if(area = '', '—', area)                               AS area_display,
           locality                                               AS locality,
           arrayStringConcat(arrayDistinct(arrayFilter(x -> x != '', [area, locality])), ', ')
                                                                  AS what_the_agent_would_say
    FROM geo.districts WHERE city = 'belgrade'
    ORDER BY h3_8 LIMIT 4 FORMAT PrettyCompactMonoBlock"
}

verify() {
    echo
    verify_ground_truth
    verify_coverage
    verify_join
    verify_belgrade_reads_naturally
}

main() {
    if [[ "${1:-}" == "verify" ]]; then verify; return; fi

    log "applying db/clickhouse/005_districts_schema.sql"
    apply_sql_file db/clickhouse/005_districts_schema.sql

    local spec
    for spec in "${CITIES[@]}"; do load_city "$spec"; done

    verify
    echo
    ok "geo.districts ready — the agent may now name a place it can prove it is in"
}

main "$@"
