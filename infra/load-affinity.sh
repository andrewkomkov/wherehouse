#!/usr/bin/env bash
# Build geo.affinity + geo.affinity_dict — the editorial complementary-business heuristic that
# gives the map a "neighbourhood fit" colour without ever entering the measured GAP rank. See
# db/clickhouse/007_affinity.sql for why the weights are opinion, not measurement, and why that
# distinction is load-bearing (constitution II).
#
# The whole matrix is fully specified in the schema file, so this is DROP + CREATE, not a patch:
# re-running replaces the table and refreshes the dictionary. Idempotent and cheap.
#
#   ./infra/load-affinity.sh          # apply schema + verify
#   ./infra/load-affinity.sh verify   # verification only, no writes

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# shellcheck source=lib.sh
source infra/lib.sh
load_env

: "${CLICKHOUSE_URL:?missing in .env}"
: "${CLICKHOUSE_PASSWORD:?missing in .env}"

# `ch` and `apply_sql_file` live in infra/lib.sh — shared with load-districts.sh / load-population.sh.

# The dictionary must actually answer, not merely exist. A known key returns its editorial weight;
# a miss returns 0. Asserted, not printed — a loader that reports success while the dict is empty
# is the failure mode worth catching (constitution II).
verify_dict() {
    log "dict answers: cafe ← hair_salon must be the editorial 0.9, a miss must be 0"
    local hit miss
    hit="$(ch "SELECT dictGetFloat32('geo.affinity_dict','weight',('cafe','hair_salon'))")"
    miss="$(ch "SELECT dictGetFloat32('geo.affinity_dict','weight',('cafe','__no_such_trade__'))")"
    # bc-free float compare: awk exits nonzero if the assertion fails.
    awk -v h="$hit" -v m="$miss" 'BEGIN { exit !(h > 0 && m == 0) }' \
        || die "dict check FAILED — got hit='$hit' miss='$miss' (want hit>0, miss=0)"
    ok "  cafe ← hair_salon = $hit, miss = $miss"
}

# The shape the request path uses: per candidate cell, sum the editorial weight of every
# complementary place within one H3 ring. Must return a positive best-fit cell over a real city,
# or the join wiring is broken even though the dict answers.
verify_fit() {
    echo
    log "per-cell neighbourhood fit (Berlin, target 'cafe') — top 3 must be > 0"
    ch "
    SELECT h3ToString(cand)                                                          AS h3,
           round(sum(dictGetFloat32('geo.affinity_dict','weight',('cafe', category))), 2) AS fit
    FROM (SELECT arrayJoin(h3kRing(h3_8, 1)) AS cand, category FROM geo.places WHERE city='berlin')
    GROUP BY cand ORDER BY fit DESC LIMIT 3 FORMAT PrettyCompactMonoBlock"

    local best
    best="$(ch "
    SELECT sum(dictGetFloat32('geo.affinity_dict','weight',('cafe', category))) AS fit
    FROM (SELECT arrayJoin(h3kRing(h3_8, 1)) AS cand, category FROM geo.places WHERE city='berlin')
    GROUP BY cand ORDER BY fit DESC LIMIT 1")"
    awk -v b="$best" 'BEGIN { exit !(b > 0) }' \
        || die "fit check FAILED — best Berlin cafe fit was '$best', want > 0"
    ok "  best Berlin cafe fit = $best"
}

verify() {
    echo
    verify_dict
    verify_fit
}

main() {
    if [[ "${1:-}" == "verify" ]]; then verify; return; fi

    log "applying db/clickhouse/007_affinity.sql"
    apply_sql_file db/clickhouse/007_affinity.sql
    ok "geo.affinity loaded: $(ch "SELECT count() FROM geo.affinity") editorial rows"

    verify
    echo
    ok "geo.affinity_dict ready — an EDITORIAL fit signal, shown labelled, never in the GAP rank"
}

main "$@"
