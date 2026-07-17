#!/usr/bin/env bash
# Create web.layers — the by-reference store that keeps a wide map layer off the chat
# stream, which caps a single record at ~1 MiB. See db/clickhouse/004_layers_schema.sql.
#
# Idempotent: CREATE ... IF NOT EXISTS, so re-running is a no-op.
#
#   ./infra/load-layers.sh          # apply + verify
#   ./infra/load-layers.sh verify   # verification only, no writes

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# shellcheck source=lib.sh
source infra/lib.sh
load_env

: "${CLICKHOUSE_URL:?missing in .env}"
: "${CLICKHOUSE_PASSWORD:?missing in .env}"
: "${CLICKHOUSE_SITE_USER:?missing in .env}"
: "${CLICKHOUSE_SITE_PASSWORD:?missing in .env}"

# The whole point of the table is that the BROWSER can read it. Proving that `default` can
# is worth nothing — `default` can read anything. So the check authenticates as `site`
# (readonly=1) and sends an Origin, exactly as a browser does.
#
# Origin matters: ClickHouse echoes CORS headers ONLY when the request carries one. A curl
# without it shows no Access-Control-* at all and reads exactly like "CORS is broken on
# Cloud" — it isn't. That phantom nearly triggered a redesign on 19 July.
verify() {
    # Unique per run, and never deleted — the TTL reaps it.
    #
    # Both halves of that matter. A fixed probe id plus a `DELETE FROM` at the end of the
    # check races the NEXT run: the delete leaves a mutation keyed on that id, and while it
    # is still applying, the next run's freshly inserted probe gets filtered out by it. The
    # INSERT reports success and the row is simply not there — which reads exactly like a
    # broken permission. Cost real time on 19 July, and it reproduces only when the runs are
    # close together, so it would have come back later at a worse moment.
    #
    # The product does not have this problem: real handles are random per emission and are
    # never deleted, only TTL'd. This was a self-check bug, not a design one.
    local probe="selfcheck-$$-${RANDOM}"

    log "writing a probe row as default"
    ch "INSERT INTO web.layers (id, body) VALUES ('$probe', '{\"type\":\"FeatureCollection\",\"features\":[]}')" >/dev/null

    log "reading it back the way the browser will: site user, GET, Origin set"
    local headers body
    headers="$(curl -sS -D- -o /dev/null -G "$CLICKHOUSE_URL/" \
        -H "Origin: http://localhost:3000" \
        --data-urlencode "user=$CLICKHOUSE_SITE_USER" \
        --data-urlencode "password=$CLICKHOUSE_SITE_PASSWORD" \
        --data-urlencode "query=SELECT body FROM web.layers WHERE id='$probe' FORMAT RawBLOB")"
    body="$(curl -sS -G "$CLICKHOUSE_URL/" \
        -H "Origin: http://localhost:3000" \
        --data-urlencode "user=$CLICKHOUSE_SITE_USER" \
        --data-urlencode "password=$CLICKHOUSE_SITE_PASSWORD" \
        --data-urlencode "query=SELECT body FROM web.layers WHERE id='$probe' FORMAT RawBLOB")"

    grep -qi '^access-control-allow-origin: \*' <<<"$headers" \
        || die "no CORS header — the browser will not be able to read layers"
    ok "cors open to the browser"

    [[ "$body" == '{"type":"FeatureCollection","features":[]}' ]] \
        || die "site user could not read web.layers, got: ${body:0:120}"
    # NB: this passing with NO grant having been issued is the point. `site` holds
    # GRANT SELECT ON web.*, a wildcard that already covers new tables. If you are ever
    # tempted to fix a permission error here with a GRANT: don't. Access DDL is what
    # permanently wedged p_html / web_html / web_html2.
    ok "site user (readonly=1) reads web.layers — no access DDL needed"

    # FR-015: no TTL means a week of demos silently accumulates. system.tables has no
    # ttl column at all (checked — not guessed), so read the DDL Cloud actually stored.
    # Note it rewrites MergeTree -> SharedMergeTree, and normalises the interval to
    # toIntervalHour(1); match on the column, not the literal we wrote.
    local ddl
    ddl="$(ch "SELECT create_table_query FROM system.tables WHERE database='web' AND name='layers' FORMAT RawBLOB")"
    grep -q 'TTL created_at' <<<"$ddl" || die "web.layers has no TTL — rows would accumulate forever"
    ok "ttl present: $(grep -o 'TTL [^S]*' <<<"$ddl" | head -1)"
}

main() {
    if [[ "${1:-}" == "verify" ]]; then verify; return; fi

    log "applying db/clickhouse/004_layers_schema.sql"
    apply_sql_file db/clickhouse/004_layers_schema.sql
    ok "web.layers ready"
    verify
}

main "$@"
