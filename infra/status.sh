#!/usr/bin/env bash
# What is actually running right now, and what is it costing us.
# Read-only — safe to run any time.
#
# NB: formatters use  python3 -c "$(cat <<'PY' ... PY)"  rather than  python3 - <<'PY',
# because a heredoc on `python3 -` steals stdin and the piped JSON never arrives.

# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env

ORG="$(api GET /organizations | jq_r "['result'][0]['id']")"
[[ -n "$ORG" ]] || die "no organization visible — check the API key in .env"
echo "org: $ORG"
echo

echo "── ClickHouse services ──────────────────────────────────"
api GET "/organizations/$ORG/services" | python3 -c "$(cat <<'PY'
import sys, json
for s in json.load(sys.stdin)["result"]:
    ep = next((e for e in s.get("endpoints", []) if e["protocol"] == "https"), {})
    print(f'  {s["name"]:<24} {s["state"]:<10} v{s["clickhouseVersion"]:<6} '
          f'{s["releaseChannel"]:<8} {ep.get("host","-")}:{ep.get("port","")}')
    print(f'  {"":<24} mcp={s.get("mcpEnabled")}  '
          f'idle={s.get("idleScaling")}/{s.get("idleTimeoutMinutes")}min  '
          f'mem={s.get("minTotalMemoryGb")}-{s.get("maxTotalMemoryGb")}GB')
PY
)"

echo
echo "── Managed Postgres (OLTP) ──────────────────────────────"
api GET "/organizations/$ORG/postgres" | python3 -c "$(cat <<'PY'
import sys, json
rows = json.load(sys.stdin)["result"]
if not rows:
    print("  (none)")
for p in rows:
    print(f'  {p["name"]:<24} {p["state"]:<10} pg{p["postgresVersion"]:<3} '
          f'{p["size"]:<14} {p["storageSize"]}GB  ha={p["haType"]}')
    # hostname is only present on GET-by-id / create, not in the list response
    if p.get("hostname"):
        print(f'  {"":<24} {p["hostname"]}')
PY
)"

echo
echo "── ClickPipes (CDC) ─────────────────────────────────────"
SVC="$(api GET "/organizations/$ORG/services" | jq_r "['result'][0]['id']")"
api GET "/organizations/$ORG/services/$SVC/clickpipes" 2>/dev/null | python3 -c "$(cat <<'PY'
import sys, json
try:
    rows = json.load(sys.stdin)["result"]
except Exception:
    rows = []
if not rows:
    print("  (none)")
for p in rows:
    src = next(iter(p.get("source", {})), "?")
    dst = p.get("destination", {}).get("database", "?")
    print(f'  {p["name"]:<24} {p["state"]:<12} {src} -> {dst}')
PY
)"

echo
echo "── CDC freshness ────────────────────────────────────────"
if [[ -n "${CLICKHOUSE_PASSWORD:-}" && -n "${CLICKHOUSE_URL:-}" ]]; then
    curl -s --user "default:$CLICKHOUSE_PASSWORD" "$CLICKHOUSE_URL/" --data-binary "
      SELECT concat('  ', name, ': ', toString(total_rows), ' rows')
      FROM system.tables WHERE database='oltp' AND name LIKE 'pg_%'
      ORDER BY name FORMAT TSVRaw" 2>/dev/null || echo "  (clickhouse unreachable)"
else
    echo "  (CLICKHOUSE_URL / CLICKHOUSE_PASSWORD unset in .env)"
fi

echo
echo "── Trigger.dev (prod deployment — infra/deploy-trigger.sh) ──"
# The deployed task itself isn't queryable read-only over the REST API with a plain PAT
# (the envvars-list and deployments-list endpoints both 401 a personal access token that
# the import/prod-key endpoints happily accept — verified, not assumed; asymmetry left
# undiagnosed since deploy-trigger.sh doesn't need those endpoints). So this reports what
# CAN be checked read-only: local CLI auth, whether .env holds a prod key, and a live probe
# of the one thing that actually proves the wiring — the deployed Worker minting a token.
if command -v pnpm >/dev/null 2>&1 && (cd "$ROOT/web" && pnpm exec trigger whoami >/dev/null 2>&1); then
    echo "  trigger CLI: authenticated"
else
    echo "  trigger CLI: not authenticated locally ('cd web && pnpm exec trigger login')"
fi
if [[ -n "${TRIGGER_SECRET_KEY_PROD:-}" ]]; then
    echo "  TRIGGER_SECRET_KEY_PROD: set (${TRIGGER_SECRET_KEY_PROD:0:12}…) — the Worker should hold this, not the tr_dev_ key"
else
    echo "  TRIGGER_SECRET_KEY_PROD: unset in .env — run ./infra/deploy-trigger.sh"
fi
resp="$(curl -sS --max-time 15 -X POST https://app.slim-shaggy.com/api/token \
    -H 'content-type: application/json' -d '{"chatId":"status-check"}' 2>/dev/null || echo '')"
if grep -q '"token"' <<<"$resp"; then
    echo "  POST /api/token: mints OK (does not by itself prove it's the prod key — see docs/PLAN.md)"
else
    echo "  POST /api/token: FAILED — $resp"
fi

echo
echo "── App (ADR-003 'for real' — infra/app-worker) ──────────"
# Cloudflare side, not the ClickHouse Cloud API — a live GET, not a config check, because
# the config can look fine while the bundle in web.assets is stale or the Worker is wedged.
if command -v curl >/dev/null 2>&1; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://app.slim-shaggy.com/ 2>/dev/null || echo "000")"
    echo "  https://app.slim-shaggy.com/  -> HTTP $code"
fi
if [[ -n "${CLICKHOUSE_PASSWORD:-}" && -n "${CLICKHOUSE_URL:-}" ]]; then
    curl -s --user "default:$CLICKHOUSE_PASSWORD" "$CLICKHOUSE_URL/" --data-binary "
      SELECT concat('  web.assets: ', toString(count()), ' files, ', formatReadableSize(sum(length(body))), ' total, newest ', toString(max(updated_at)))
      FROM web.assets FORMAT TSVRaw" 2>/dev/null
fi
if command -v wrangler >/dev/null 2>&1 && wrangler whoami >/dev/null 2>&1; then
    echo "  $(wrangler hyperdrive list 2>/dev/null | grep -c wherehouse-pg-hyperdrive || echo 0) Hyperdrive config(s) named wherehouse-pg-hyperdrive"
else
    echo "  (wrangler not authenticated — 'wrangler login' to check Hyperdrive/cert state)"
fi
