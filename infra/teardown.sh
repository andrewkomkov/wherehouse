#!/usr/bin/env bash
# Destroy the billable infrastructure.
#
# There is one billable thing left: the ClickHouse service. It is not touched without
# `--all`, because it holds every byte the product has — Overture-derived `geo.places`,
# Kontur population, the isochrones, the static bundle in `web.assets` and the user's saved
# sites. Deleting it means re-running the loaders, not just re-running provision.sh.
#
# The managed Postgres (`wherehouse-oltp`) and the ClickPipe (`wherehouse-pg-cdc`) this
# script used to delete were removed for good on 2026-08-01 (ADR-005) — saved sites live in
# ClickHouse now, so there is no second store to tear down. Same for the Cloudflare
# Hyperdrive config and its uploaded CA cert, which existed only to reach that Postgres.
#
#   ./infra/teardown.sh              # report what is billable, delete nothing
#   ./infra/teardown.sh --all        # delete the ClickHouse service itself
#
# Not covered here (different provider, wrangler OAuth is not a .env credential): the R2
# bucket and the two Cloudflare Workers. `wrangler r2 bucket delete wherehouse-basemaps` and
# `wrangler delete` in infra/app-worker/ + infra/basemap-worker/ if those go too.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env

ALL="${1:-}"

ORG="$(api GET /organizations | jq_r "['result'][0]['id']")"

confirm() {
    printf '\033[33m?\033[0m %s [y/N] ' "$1"
    read -r a; [[ "$a" == "y" || "$a" == "Y" ]]
}

# ── ClickHouse service ───────────────────────────────────────────────────────

SVC="$(api GET "/organizations/$ORG/services" | jq_r "['result'][0]['id']")"
[[ -n "$SVC" ]] || die "no ClickHouse service visible — nothing to tear down"

api GET "/organizations/$ORG/services/$SVC" | python3 -c "$(cat <<'PY'
import sys, json
s = json.load(sys.stdin)["result"]
print(f'  {s["name"]}  {s["state"]}  v{s["clickhouseVersion"]}  '
      f'mem={s.get("minTotalMemoryGb")}-{s.get("maxTotalMemoryGb")}GB  '
      f'idle={s.get("idleScaling")}/{s.get("idleTimeoutMinutes")}min')
PY
)"

if [[ "$ALL" != "--all" ]]; then
    log "nothing deleted. Pass --all to delete the ClickHouse service above."
    exit 0
fi

warn "the service holds ALL the data — places, population, isochrones, web.assets, saved sites"
if confirm "REALLY delete the ClickHouse service $SVC?"; then
    api PATCH "/organizations/$ORG/services/$SVC/state" '{"command":"stop"}' >/dev/null || true
    wait_state "api GET /organizations/$ORG/services/$SVC" "['result']['state']" stopped "service"
    api DELETE "/organizations/$ORG/services/$SVC" >/dev/null
    ok "service deleted"
fi

echo; ok "teardown done. ./infra/status.sh to confirm."
