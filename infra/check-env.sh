#!/usr/bin/env bash
# Verify every credential in .env actually works. Read-only, safe, ~5 seconds.
# Run this FIRST in a new session — "stored" and "working" are different things.

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

if [[ ! -f .env ]]; then echo "✗ no .env — copy .env.example and fill it in"; exit 1; fi

# NB: POSTGRES_URL must be quoted inside .env — an unquoted & aborts the parse and
# silently drops every line below it. That cost us a confusing "key MISSING" once.
set -a; source .env; set +a

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %-22s %s\n' "$1" "$2"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %-22s %s\n' "$1" "$2"; fail=$((fail+1)); }
warn() { printf '  \033[33m!\033[0m %-22s %s\n' "$1" "$2"; }

echo "checking .env against live services…"

V=$(curl -sf --max-time 20 --user "default:$CLICKHOUSE_PASSWORD" "$CLICKHOUSE_URL/" --data-binary "SELECT version()" 2>/dev/null)
[[ -n "$V" ]] && ok "clickhouse (default)" "v$V" || bad "clickhouse (default)" "unreachable — service may be idle, retry once"

PW=$(python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ.get('CLICKHOUSE_SITE_PASSWORD','')))")
R=$(curl -sf --max-time 20 "$CLICKHOUSE_URL/?user=${CLICKHOUSE_SITE_USER}&password=${PW}" --data-binary "SELECT count() FROM web.pages" 2>/dev/null)
[[ -n "$R" ]] && ok "clickhouse (site ro)" "web.pages: $R row(s) — ADR-003" || bad "clickhouse (site ro)" "public read-only user broken"

O=$(curl -sf --max-time 20 -u "$CLICKHOUSE_API_KEY_ID:$CLICKHOUSE_API_KEY_SECRET" https://api.clickhouse.cloud/v1/organizations 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['result'][0]['id'])" 2>/dev/null)
[[ -n "$O" ]] && ok "cloud api" "org $O" || bad "cloud api" "key rejected"

PSQL=psql; command -v psql >/dev/null || PSQL=/opt/homebrew/opt/libpq/bin/psql
if [[ -f .secrets/pg-ca.crt ]]; then
    P=$("$PSQL" "$POSTGRES_URL" -t -A -c "SELECT count(*) FROM saved_sites;" 2>/dev/null)
    [[ -n "$P" ]] && ok "postgres (oltp)" "saved_sites: $P" || bad "postgres (oltp)" "unreachable — check CA cert / instance state"
else
    bad "postgres (oltp)" ".secrets/pg-ca.crt missing — GET /postgres/{id}/caCertificates"
fi

C=$(curl -sf --max-time 20 --user "default:$CLICKHOUSE_PASSWORD" "$CLICKHOUSE_URL/" --data-binary "SELECT count() FROM oltp.pg_saved_sites" 2>/dev/null)
if [[ -n "$C" && -n "${P:-}" ]]; then
    [[ "$C" == "$P" ]] && ok "clickpipes cdc" "$C rows, in sync with postgres" \
                       || warn "clickpipes cdc" "pg=$P ch=$C — lag, or the slot died. See ADR-004 (resync)."
else
    bad "clickpipes cdc" "oltp.pg_saved_sites unreadable"
fi

[[ -n "$TRIGGER_SECRET_KEY" ]] && ok "trigger.dev key" "${TRIGGER_SECRET_KEY:0:8}… (not validated)" || bad "trigger.dev key" "unset"

# Actually call the model — an unset-vs-set check told us nothing useful.
if [[ -n "$ANTHROPIC_API_KEY" ]]; then
    BASE="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
    A=$(curl -sf --max-time 30 "$BASE/v1/messages" \
          -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
          -H "content-type: application/json" \
          -d "{\"model\":\"${LLM_MODEL:-claude-sonnet-4-5}\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}]}" 2>/dev/null \
        | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('model','?'))" 2>/dev/null)
    [[ -n "$A" ]] && ok "llm ($BASE)" "$A responds" || bad "llm ($BASE)" "model ${LLM_MODEL:-?} did not answer"
else
    warn "llm" "ANTHROPIC_API_KEY unset — chat.agent() needs it"
fi

# DeepSeek only: balance is small and burns silently.
if [[ "${ANTHROPIC_BASE_URL:-}" == *deepseek* ]]; then
    B=$(curl -sf --max-time 20 https://api.deepseek.com/user/balance -H "Authorization: Bearer $ANTHROPIC_API_KEY" 2>/dev/null \
        | python3 -c "import sys,json;print(json.load(sys.stdin)['balance_infos'][0]['total_balance'])" 2>/dev/null)
    if [[ -n "$B" ]]; then
        awk -v b="$B" 'BEGIN{exit !(b+0 < 1)}' && warn "deepseek balance" "\$$B — LOW, top up" || ok "deepseek balance" "\$$B"
    fi
fi

echo
[[ $fail -eq 0 ]] && echo "  $pass ok, $fail broken" || { echo "  $pass ok, $fail BROKEN"; exit 1; }
