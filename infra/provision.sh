#!/usr/bin/env bash
# Rebuild the entire WhereHouse backend from nothing, via the ClickHouse Cloud REST API.
#
# Idempotent: every step checks for an existing resource first, so re-running is safe.
# This exists because the hackathon deadline is server-enforced — if the service has to
# be recreated at 2am on 22 July, that must be one command, not archaeology.
#
#   ./infra/provision.sh            # everything
#   ./infra/provision.sh postgres   # just the OLTP side + CDC
#
# Prereq: .env with CLICKHOUSE_API_KEY_ID / CLICKHOUSE_API_KEY_SECRET.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env

SERVICE_NAME="trigger-dev-hackathon"
PG_NAME="wherehouse-oltp"
PIPE_NAME="wherehouse-pg-cdc"
REGION="eu-west-1"
TARGET="${1:-all}"

ORG="$(api GET /organizations | jq_r "['result'][0]['id']")"
[[ -n "$ORG" ]] || die "no organization visible — check the API key"
log "org $ORG"

# ── ClickHouse service ───────────────────────────────────────────────────────

find_service() {
    api GET "/organizations/$ORG/services" | python3 -c "
import sys, json
for s in json.load(sys.stdin)['result']:
    if s['name'] == '$SERVICE_NAME': print(s['id']); break
"
}

SVC="$(find_service)"
if [[ -z "$SVC" ]]; then
    log "creating ClickHouse service $SERVICE_NAME"
    SVC="$(api POST "/organizations/$ORG/services" "$(python3 -c "
import json; print(json.dumps({
  'name': '$SERVICE_NAME', 'provider': 'aws', 'region': '$REGION',
  'tier': 'production', 'releaseChannel': 'fast',
  'ipAccessList': [{'source': '0.0.0.0/0', 'description': 'Anywhere'}],
}))")" | jq_r "['result']['service']['id']")"
    ok "service created: $SVC"
else
    ok "service exists: $SVC"
fi

# The fast channel is what gets us newer geo features. Cloud still trails open-source by
# ~2 releases (26.4 vs 26.6 as of 2026-07-17) — see ADR-003.
CHAN="$(api GET "/organizations/$ORG/services/$SVC" | jq_r "['result']['releaseChannel']")"
if [[ "$CHAN" != "fast" ]]; then
    log "switching release channel: $CHAN -> fast"
    api PATCH "/organizations/$ORG/services/$SVC" '{"releaseChannel":"fast"}' >/dev/null
    warn "upgrade is async — do NOT run access DDL until it settles (it wedges access entities, see ADR-003)"
fi
VER="$(api GET "/organizations/$ORG/services/$SVC" | jq_r "['result']['clickhouseVersion']")"
ok "clickhouse $VER (channel $CHAN)"

[[ "$TARGET" == "service" ]] && exit 0

# ── Managed Postgres (OLTP side, ADR-004) ────────────────────────────────────

find_pg() {
    api GET "/organizations/$ORG/postgres" | python3 -c "
import sys, json
for p in json.load(sys.stdin)['result']:
    if p['name'] == '$PG_NAME': print(p['id']); break
"
}

PG_ID="$(find_pg)"
if [[ -z "$PG_ID" ]]; then
    log "creating managed Postgres $PG_NAME"
    RESP="$(api POST "/organizations/$ORG/postgres" "$(python3 -c "
import json; print(json.dumps({
  'name': '$PG_NAME', 'provider': 'aws', 'region': '$REGION',
  'postgresVersion': '18', 'size': 'c6gd.large', 'haType': 'none',
}))")")"
    PG_ID="$(jq_r "['result']['id']" <<<"$RESP")"
    PG_PW="$(jq_r "['result']['password']" <<<"$RESP")"
    PG_HOST="$(jq_r "['result']['hostname']" <<<"$RESP")"
    ok "postgres created: $PG_ID"
    warn "password is returned ONCE — write it to .env now:"
    echo "    POSTGRES_HOST=$PG_HOST"
    echo "    POSTGRES_PASSWORD=$PG_PW"
else
    ok "postgres exists: $PG_ID"
fi

wait_state "api GET /organizations/$ORG/postgres/$PG_ID" "['result']['state']" running "postgres"

# The server cert is Ubicloud-issued; sslmode=require alone fails verification.
# This endpoint returns raw PEM, not JSON.
mkdir -p "$ROOT/.secrets"
api GET "/organizations/$ORG/postgres/$PG_ID/caCertificates" > "$ROOT/.secrets/pg-ca.crt"
ok "CA cert -> .secrets/pg-ca.crt"

# ── Schema ───────────────────────────────────────────────────────────────────

PSQL=psql
command -v psql >/dev/null || PSQL=/opt/homebrew/opt/libpq/bin/psql
if [[ -x "$PSQL" || -n "$(command -v $PSQL)" ]] && [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
    PG_URI="postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:5432/${POSTGRES_DB:-postgres}?sslmode=verify-full&sslrootcert=$ROOT/.secrets/pg-ca.crt"
    log "applying OLTP schema"
    "$PSQL" "$PG_URI" -v ON_ERROR_STOP=1 -q -f "$ROOT/db/postgres/001_oltp_schema.sql"
    ok "schema applied (publication wherehouse_pub)"
else
    warn "skipping schema — psql not found or POSTGRES_PASSWORD unset in .env"
fi

# ── ClickPipe CDC ────────────────────────────────────────────────────────────

log "ensuring target database oltp"
curl -s --user "default:${CLICKHOUSE_PASSWORD}" "${CLICKHOUSE_URL}/" \
     --data-binary "CREATE DATABASE IF NOT EXISTS oltp" >/dev/null

find_pipe() {
    api GET "/organizations/$ORG/services/$SVC/clickpipes" 2>/dev/null | python3 -c "
import sys, json
try: r = json.load(sys.stdin)['result']
except Exception: r = []
for p in r:
    if p['name'] == '$PIPE_NAME': print(p['id']); break
" 2>/dev/null
}

PIPE="$(find_pipe)"
if [[ -z "$PIPE" ]]; then
    log "creating ClickPipe $PIPE_NAME (postgres CDC)"
    BODY="$(python3 - <<PY
import json
ca = open("$ROOT/.secrets/pg-ca.crt").read()
print(json.dumps({
 "name": "$PIPE_NAME",
 "source": {"postgres": {
   "type": "postgres",
   "host": "${POSTGRES_HOST}", "port": 5432, "database": "${POSTGRES_DB:-postgres}",
   "authentication": "basic",
   "credentials": {"username": "${POSTGRES_USER:-postgres}", "password": "${POSTGRES_PASSWORD}"},
   "caCertificate": ca,
   "settings": {"replicationMode": "cdc", "publicationName": "wherehouse_pub",
                "syncIntervalSeconds": 10},
   "tableMappings": [
     {"sourceSchemaName": "public", "sourceTable": "shortlists",
      "targetTable": "pg_shortlists", "tableEngine": "ReplacingMergeTree"},
     {"sourceSchemaName": "public", "sourceTable": "saved_sites",
      "targetTable": "pg_saved_sites", "tableEngine": "ReplacingMergeTree"},
   ]}},
 "destination": {"database": "oltp"},
}))
PY
)"
    PIPE="$(api POST "/organizations/$ORG/services/$SVC/clickpipes" "$BODY" | jq_r "['result']['id']")"
    ok "pipe created: $PIPE"
else
    ok "pipe exists: $PIPE"
fi

wait_state "api GET /organizations/$ORG/services/$SVC/clickpipes/$PIPE" "['result']['state']" Running "clickpipe"

echo
ok "provisioned. run ./infra/status.sh to inspect, ./infra/teardown.sh to destroy."
