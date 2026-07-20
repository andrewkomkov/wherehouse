#!/usr/bin/env bash
# Load the Overture built-environment demand layer — buildings (capacity), addresses (occupancy)
# and transportation (frontage) — into ClickHouse, so the agent can reason about demand beyond raw
# Kontur headcount. See db/clickhouse/011_overture_demand.sql for WHAT each signal is and why.
#
# Everything reads Overture parquet in place from public S3 (ADR-002). Buildings are materialised
# (~1.57M footprints, the volume centrepiece) and rolled into geo.cell_capacity by an incremental
# AggregatingMergeTree MV; addresses and transportation are aggregated to one row per res-8 cell.
#
# Idempotent: each city is replaced via DROP PARTITION before it is re-inserted. Because the
# capacity MV uses sum/count (NOT idempotent, unlike 008_history's argMin/argMax), the buildings
# reload ALSO drops the matching geo.cell_capacity partition first — see the schema for why.
#
#   ./infra/load-overture-demand.sh          # apply schema + load all cities + verify
#   ./infra/load-overture-demand.sh verify   # verification only, no writes, no S3 reads

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# shellcheck source=lib.sh
source infra/lib.sh
load_env

: "${CLICKHOUSE_URL:?missing in .env}"
: "${CLICKHOUSE_PASSWORD:?missing in .env}"

# Overture release. Pinned exactly as load-districts.sh / load-population.sh pin theirs: Overture
# rotates releases monthly, and a silently newer release would move footprint counts under the
# demo. Enumerate available releases with:
#   curl -s "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&delimiter=/&prefix=release/"
RELEASE="2026-06-17.0"
BASE="https://overturemaps-us-west-2.s3.amazonaws.com/release/$RELEASE"
BUILDINGS="$BASE/theme=buildings/type=building/*.parquet"
ADDRESSES="$BASE/theme=addresses/type=address/*.parquet"
SEGMENTS="$BASE/theme=transportation/type=segment/*.parquet"

# city:latMin:latMax:lonMin:lonMax — COPIED from web/src/trigger/scoring.ts CITIES (which copied
# them from db/clickhouse/002_places_load.sql). They MUST match the boxes geo.places and
# geo.population use, or a demand cell would not line up with a scored cell. Change one, change all.
CITIES=(
    "berlin:52.338:52.675:13.088:13.761"
    "amsterdam:52.27:52.44:4.68:5.07"
    "belgrade:44.66:44.92:20.2:20.65"
)

# ---- per-signal INSERT builders -------------------------------------------------------------
# Each takes the city bbox and returns one SELECT to feed an INSERT. Every S3 read filters on
# bbox.* (row-group pruning), never geometry; every H3 call is LAT-FIRST.

buildings_select() {
    local city="$1" lat_min="$2" lat_max="$3" lon_min="$4" lon_max="$5"
    cat <<SQL
SELECT
    coalesce(id, '')                       AS id,
    '$city'                                AS city,
    (bbox.xmin + bbox.xmax) / 2            AS lon,
    (bbox.ymin + bbox.ymax) / 2            AS lat,
    height,
    num_floors,
    -- Spherical footprint area in m2, decoded ONCE here so the read path never touches geometry.
    -- Polygon or MultiPolygon; abs() because polygonAreaSpherical's sign follows ring winding.
    abs(if(variantType(geometry) = 'Polygon',
           polygonAreaSpherical(variantElement(geometry, 'Polygon')),
           arraySum(arrayMap(p -> polygonAreaSpherical(p),
                             variantElement(geometry, 'MultiPolygon'))))) * 6371007.18 * 6371007.18 AS area_m2,
    coalesce(subtype, '')                  AS subtype
FROM s3('$BUILDINGS')
WHERE bbox.xmin BETWEEN $lon_min AND $lon_max
  AND bbox.ymin BETWEEN $lat_min AND $lat_max
SETTINGS max_execution_time = 290
SQL
}

addresses_select() {
    local city="$1" lat_min="$2" lat_max="$3" lon_min="$4" lon_max="$5"
    cat <<SQL
SELECT '$city' AS city,
       geoToH3(geometry.2, geometry.1, 8) AS h3_8,
       count()                            AS addr_count
FROM s3('$ADDRESSES')
WHERE bbox.xmin BETWEEN $lon_min AND $lon_max
  AND bbox.ymin BETWEEN $lat_min AND $lat_max
GROUP BY h3_8
SETTINGS max_execution_time = 290
SQL
}

road_select() {
    local city="$1" lat_min="$2" lat_max="$3" lon_min="$4" lon_max="$5"
    cat <<SQL
SELECT '$city' AS city, h3_8,
       count()          AS seg_count,
       sumIf(len_m, is_road) AS road_len_m,
       sumIf(len_m, is_walk) AS walk_len_m
FROM (
    SELECT geoToH3((bbox.ymin + bbox.ymax) / 2, (bbox.xmin + bbox.xmax) / 2, 8) AS h3_8,
           -- bbox-diagonal length: a density approximation, not survey-grade metres (see schema).
           greatCircleDistance(bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax) AS len_m,
           class IN ('motorway','trunk','primary','secondary','tertiary',
                     'residential','living_street','unclassified','service') AS is_road,
           class IN ('footway','path','pedestrian','cycleway','steps','track') AS is_walk
    FROM s3('$SEGMENTS')
    WHERE subtype = 'road'
      AND bbox.xmin BETWEEN $lon_min AND $lon_max
      AND bbox.ymin BETWEEN $lat_min AND $lat_max
)
GROUP BY h3_8
SETTINGS max_execution_time = 290
SQL
}

load_city() {
    local spec="$1"
    local city lat_min lat_max lon_min lon_max
    IFS=: read -r city lat_min lat_max lon_min lon_max <<<"$spec"

    # Buildings + its capacity rollup drop in lockstep (sum/count are not idempotent).
    log "$city: buildings — replacing partition (+ cell_capacity)"
    ch "ALTER TABLE geo.buildings DROP PARTITION '$city'" >/dev/null
    ch "ALTER TABLE geo.cell_capacity DROP PARTITION '$city'" >/dev/null
    ch "INSERT INTO geo.buildings (id, city, lon, lat, height, num_floors, area_m2, subtype)
        $(buildings_select "$city" "$lat_min" "$lat_max" "$lon_min" "$lon_max")" >/dev/null
    ok "$city: $(ch "SELECT count() FROM geo.buildings WHERE city='$city'") footprints"

    log "$city: addresses — replacing partition"
    ch "ALTER TABLE geo.addr_density DROP PARTITION '$city'" >/dev/null
    ch "INSERT INTO geo.addr_density (city, h3_8, addr_count)
        $(addresses_select "$city" "$lat_min" "$lat_max" "$lon_min" "$lon_max")" >/dev/null
    ok "$city: $(ch "SELECT count() FROM geo.addr_density WHERE city='$city'") address cells"

    log "$city: transportation — replacing partition"
    ch "ALTER TABLE geo.road_density DROP PARTITION '$city'" >/dev/null
    ch "INSERT INTO geo.road_density (city, h3_8, seg_count, road_len_m, walk_len_m)
        $(road_select "$city" "$lat_min" "$lat_max" "$lon_min" "$lon_max")" >/dev/null
    ok "$city: $(ch "SELECT count() FROM geo.road_density WHERE city='$city'") road cells"
}

# Non-degenerate thresholds, measured live 2026-07-20 (a check that has never failed is decoration,
# constitution II). Buildings counts are the S3 measurements minus a margin; the MV must roll to
# the SAME building count as the raw table (the whole point of the rollup), and every signal must
# actually populate cells.
verify() {
    echo
    log "verify: every signal is present and non-degenerate, and the capacity MV agrees with raw"
    local failed=0

    check_ge() { # value threshold label
        if awk -v v="$1" -v t="$2" 'BEGIN { exit !(v+0 >= t+0) }'; then
            ok "  $3: $1 (>= $2)"
        else
            warn "  $3: $1 (want >= $2)"; failed=1
        fi
    }

    check_ge "$(ch "SELECT count() FROM geo.buildings WHERE city='berlin'")"    800000 "berlin footprints"
    check_ge "$(ch "SELECT count() FROM geo.buildings WHERE city='amsterdam'")" 300000 "amsterdam footprints"
    check_ge "$(ch "SELECT count() FROM geo.buildings WHERE city='belgrade'")"  250000 "belgrade footprints"

    # The MV's building count must equal the raw table's — proves the rollup covered every row and
    # did not double-count a reload (the non-idempotent-aggregate trap the partition drop guards).
    local raw mv
    raw="$(ch "SELECT count() FROM geo.buildings")"
    mv="$(ch "SELECT toUInt64(countMerge(buildings)) FROM geo.cell_capacity")"
    if [[ "$raw" == "$mv" ]]; then
        ok "  cell_capacity MV == raw buildings: $mv"
    else
        warn "  cell_capacity MV ($mv) != raw buildings ($raw) — rollup miscount"; failed=1
    fi

    check_ge "$(ch "SELECT round(sumMerge(floor_area_m2)) FROM geo.cell_capacity WHERE city='berlin'")" 100000000 "berlin floor-area m2"
    check_ge "$(ch "SELECT count() FROM geo.addr_density WHERE city='berlin'")" 1500 "berlin address cells"
    check_ge "$(ch "SELECT count() FROM geo.road_density WHERE city='berlin'")" 2000 "berlin road cells"

    [[ "$failed" -eq 0 ]] || die "overture demand verification FAILED — see warnings above"
    echo
    ok "geo.buildings / cell_capacity / addr_density / road_density ready"
}

main() {
    if [[ "${1:-}" == "verify" ]]; then verify; return; fi

    log "applying db/clickhouse/011_overture_demand.sql (tables + capacity MV must exist first)"
    apply_sql_file db/clickhouse/011_overture_demand.sql

    for spec in "${CITIES[@]}"; do
        load_city "$spec"
    done

    verify
}

main "$@"
