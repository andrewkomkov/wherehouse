#!/usr/bin/env bash
# Rebuild the entire WhereHouse backend from nothing, via the ClickHouse Cloud REST API.
#
# Idempotent: every step checks for an existing resource first, so re-running is safe.
# This exists because the hackathon deadline is server-enforced — if the service has to
# be recreated at 2am on 22 July, that must be one command, not archaeology.
#
#   ./infra/provision.sh            # everything
#   ./infra/provision.sh service    # just the ClickHouse service
#
# Prereq: .env with CLICKHOUSE_API_KEY_ID / CLICKHOUSE_API_KEY_SECRET.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env

SERVICE_NAME="trigger-dev-hackathon"
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

# ── App schema ───────────────────────────────────────────────────────────────
#
# `app.saved_sites` — the user's saved sites, in ClickHouse itself (ADR-005). This used to be
# a managed Postgres instance plus a ClickPipes CDC pipe replicating it back in (ADR-004,
# retired 2026-08-01); both are gone, and with them the Hyperdrive config the Worker needed
# to reach Postgres at all. `deploy-app.sh load` applies the same file, so a plain app
# redeploy also keeps it in step.
#
# The file ends in a GRANT — access DDL. NEVER run it while a version upgrade is settling
# (CLAUDE.md trap #4): confirm `SELECT version()` is stable across a few probes first.

log "applying db/clickhouse/014_saved_sites.sql (app.saved_sites + the site GRANT)"
apply_sql_file "$ROOT/db/clickhouse/014_saved_sites.sql"
ok "app.saved_sites ready"

# The narrow writer the Cloudflare Worker uses for the map-click save. Not in the .sql file
# because it carries a password: created here from .env, so nothing secret is ever committed.
# `default` is deliberately NOT reused — an admin credential must not live in a Worker.
if [[ -n "${CLICKHOUSE_APP_WRITER_PASSWORD:-}" ]]; then
    log "ensuring ClickHouse user ${CLICKHOUSE_APP_WRITER_USER:-app_writer}"
    ch "CREATE USER IF NOT EXISTS ${CLICKHOUSE_APP_WRITER_USER:-app_writer} IDENTIFIED WITH sha256_password BY '${CLICKHOUSE_APP_WRITER_PASSWORD}'" >/dev/null
    ch "GRANT INSERT, SELECT ON app.saved_sites TO ${CLICKHOUSE_APP_WRITER_USER:-app_writer}" >/dev/null
    ok "app_writer can INSERT/SELECT app.saved_sites and nothing else"
else
    warn "skipping app_writer — CLICKHOUSE_APP_WRITER_PASSWORD unset in .env (the Worker's save endpoint needs it)"
fi

echo
ok "provisioned. run ./infra/status.sh to inspect, ./infra/teardown.sh to destroy."
