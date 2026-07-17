#!/usr/bin/env bash
# Load Kontur Population (H3 res 8) into geo.population for the three demo cities'
# countries. Idempotent: each country is replaced via DROP PARTITION, so re-running is
# safe and cheap.
#
# Why this exists: Overture has no population layer, so without it the GAP score's
# "demand" term has nothing real behind it. See db/clickhouse/003_population_schema.sql.
#
# No GDAL required. Kontur ships GeoPackage, which is just SQLite with a geometry blob —
# and we don't want the geometry at all, only (h3, population). python3's stdlib sqlite3
# reads it directly.
#
#   ./infra/load-population.sh          # download (cached) + load + verify
#   ./infra/load-population.sh verify   # verification only, no writes

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# shellcheck source=lib.sh
source infra/lib.sh
load_env

: "${CLICKHOUSE_URL:?missing in .env}"
: "${CLICKHOUSE_PASSWORD:?missing in .env}"

# Kontur release. Pinned deliberately: the dataset is a snapshot, and a silently newer
# release would move every score without anyone noticing.
RELEASE="20231101"
BASE="https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets"
CACHE="${TMPDIR:-/tmp}/wherehouse-kontur"

# country -> the demo city it serves
COUNTRIES=(DE NL RS)

# `ch` and `apply_sql_file` live in infra/lib.sh — shared with load-layers.sh.

fetch() {
    local cc="$1" gz="$CACHE/$1.gpkg.gz" gpkg="$CACHE/$1.gpkg"
    mkdir -p "$CACHE"
    if [[ -f "$gpkg" ]]; then
        log "$cc: using cached $(du -h "$gpkg" | cut -f1)"
        return
    fi
    log "$cc: downloading kontur_population_${cc}_${RELEASE}.gpkg.gz"
    curl -sSL --fail -o "$gz" "$BASE/kontur_population_${cc}_${RELEASE}.gpkg.gz"
    gunzip -kf "$gz"
    ok "$cc: $(du -h "$gpkg" | cut -f1) unpacked"
}

# GeoPackage -> TSV on stdout. h3 stays a string here; ClickHouse turns it into the same
# UInt64 geoToH3 produces, via stringToH3 in the INSERT below.
dump_tsv() {
    local cc="$1"
    python3 - "$CACHE/$cc.gpkg" "$cc" <<'PY'
import sqlite3, sys
db, cc = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db)
out = sys.stdout
for h3, pop in con.execute(
    "SELECT h3, population FROM population WHERE population > 0"
):
    out.write(f"{h3}\t{pop}\t{cc}\n")
PY
}

load_country() {
    local cc="$1"
    fetch "$cc"
    log "$cc: replacing partition"
    ch "ALTER TABLE geo.population DROP PARTITION '$cc'" >/dev/null
    dump_tsv "$cc" | curl -sS --fail-with-body --max-time 600 \
        --user "default:$CLICKHOUSE_PASSWORD" \
        "$CLICKHOUSE_URL/?query=$(printf %s "INSERT INTO geo.population (h3_8, population, country) SELECT stringToH3(c1), c2, c3 FROM input('c1 String, c2 Float32, c3 String') FORMAT TSV" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read()))')" \
        --data-binary @- >/dev/null
    ok "$cc: loaded $(ch "SELECT count() FROM geo.population WHERE country='$cc'") hexes"
}

# The point of the whole exercise: does a hex with people in it line up with our POIs?
# A number that merely exists proves nothing (constitution II).
verify() {
    echo
    log "verifying against reality, not against the docs"
    ch "
    SELECT country,
           formatReadableQuantity(sum(population)) AS total,
           count()                                 AS hexes
    FROM geo.population GROUP BY country ORDER BY country FORMAT PrettyCompactMonoBlock"

    echo
    log "does population join onto our own saved site?"
    ch "
    SELECT s.label,
           p.population AS people_in_cell
    FROM oltp.pg_saved_sites AS s
    INNER JOIN geo.population AS p ON stringToH3(s.h3_8) = p.h3_8
    WHERE s._peerdb_is_deleted = 0
    FORMAT PrettyCompactMonoBlock"

    echo
    log "coverage: how many of Berlin's populated cells do we have POIs for?"
    ch "
    SELECT round(100 * countIf(pop > 0) / count(), 1) AS pct_of_poi_cells_with_population
    FROM (
        SELECT pl.h3_8 AS h,
               any(p.population) AS pop
        FROM geo.places AS pl
        LEFT JOIN geo.population AS p ON pl.h3_8 = p.h3_8
        WHERE pl.city = 'berlin'
        GROUP BY h
    ) FORMAT PrettyCompactMonoBlock"
}

main() {
    if [[ "${1:-}" == "verify" ]]; then verify; return; fi

    log "applying schema"
    apply_sql_file db/clickhouse/003_population_schema.sql
    for cc in "${COUNTRIES[@]}"; do load_country "$cc"; done
    verify
    echo
    ok "geo.population ready — attribute Kontur (CC BY) wherever this is shown"
}

main "$@"
