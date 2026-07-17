#!/usr/bin/env bash
# Destroy the billable infrastructure. Run AFTER judging closes (29 July 2026).
#
# Deliberately does NOT touch the ClickHouse service by default — that one holds the
# demo data and the judges may still be looking at it. Postgres + the CDC pipe are the
# things quietly burning credits.
#
#   ./infra/teardown.sh              # postgres + clickpipe
#   ./infra/teardown.sh --all        # ...and the ClickHouse service itself

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env

PG_NAME="wherehouse-oltp"
PIPE_NAME="wherehouse-pg-cdc"
ALL="${1:-}"

ORG="$(api GET /organizations | jq_r "['result'][0]['id']")"

confirm() {
    printf '\033[33m?\033[0m %s [y/N] ' "$1"
    read -r a; [[ "$a" == "y" || "$a" == "Y" ]]
}

# ── ClickPipe ────────────────────────────────────────────────────────────────

SVC="$(api GET "/organizations/$ORG/services" | jq_r "['result'][0]['id']")"
PIPE="$(api GET "/organizations/$ORG/services/$SVC/clickpipes" 2>/dev/null | python3 -c "
import sys, json
try: r = json.load(sys.stdin)['result']
except Exception: r = []
for p in r:
    if p['name'] == '$PIPE_NAME': print(p['id']); break
" 2>/dev/null)"

if [[ -n "$PIPE" ]]; then
    if confirm "delete ClickPipe $PIPE_NAME ($PIPE)?"; then
        api DELETE "/organizations/$ORG/services/$SVC/clickpipes/$PIPE" >/dev/null
        ok "clickpipe deleted"
    fi
else
    log "no clickpipe named $PIPE_NAME"
fi

# ── Postgres ─────────────────────────────────────────────────────────────────

PG_ID="$(api GET "/organizations/$ORG/postgres" | python3 -c "
import sys, json
for p in json.load(sys.stdin)['result']:
    if p['name'] == '$PG_NAME': print(p['id']); break
")"

if [[ -n "$PG_ID" ]]; then
    if confirm "delete managed Postgres $PG_NAME ($PG_ID)? THIS DESTROYS THE OLTP DATA."; then
        api DELETE "/organizations/$ORG/postgres/$PG_ID" >/dev/null
        ok "postgres deleted"
    fi
else
    log "no postgres named $PG_NAME"
fi

# ── ClickHouse service ───────────────────────────────────────────────────────

if [[ "$ALL" == "--all" ]]; then
    warn "the ClickHouse service holds the demo data judges may still be reviewing"
    if confirm "REALLY delete the ClickHouse service $SVC?"; then
        api PATCH "/organizations/$ORG/services/$SVC/state" '{"command":"stop"}' >/dev/null || true
        wait_state "api GET /organizations/$ORG/services/$SVC" "['result']['state']" stopped "service"
        api DELETE "/organizations/$ORG/services/$SVC" >/dev/null
        ok "service deleted"
    fi
fi

echo; ok "teardown done. ./infra/status.sh to confirm."
