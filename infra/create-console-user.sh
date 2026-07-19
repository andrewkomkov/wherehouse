#!/usr/bin/env bash
# A dedicated READONLY user for the demo video's console beat — driving the real ClickHouse
# `/play` web console against `web.assets` on camera (video/capture/capture.mjs, action
# "chConsole").
#
# Why not the existing `site` user (readonly=1, GRANT SELECT ON web.* — see .env.example)?
# Verified live, 19 Jul: `/play` appends its OWN settings on every request it makes —
# `add_http_cors_header=1`, `enable_http_compression=1`, `use_query_cache=1`,
# `enable_reads_from_query_cache=0`, `enable_writes_to_query_cache=1`, `query_cache_ttl=600`,
# `query_cache_nondeterministic_function_handling=save`, `query_cache_system_table_handling=
# ignore`, `extremes=1` — and under `readonly=1` (CLAUDE.md trap #3) ClickHouse rejects ANY
# attempt to set a setting via query param with `Code: 164 … Cannot modify '<name>' setting
# in readonly mode`, even when the requested value is a no-op. `/play` cannot be driven by
# ANY user whose account carries `readonly=1` as-is — it isn't a Playwright/selector problem,
# it is this. The fix already used elsewhere in this repo for the exact same class of problem
# (ADR-003, trap #3: `http_response_headers` under readonly=1) is to bake the values `/play`
# sends as the PROFILE'S OWN DEFAULTS, so the request becomes a same-value no-op, which
# `readonly=1` does permit — verified by curl before wiring this into Playwright.
#
# `video_console` is READONLY in the same sense `site` is (readonly=1 CONST, cannot be
# loosened even by itself) and can select from exactly one table: `web.assets`. It cannot
# read `oltp.*`, `geo.*`, or anything `site` can. Never the default/admin user.
#
# Idempotent: CREATE ... IF NOT EXISTS / ALTER ... SETTINGS (both safe to re-run). Per
# CLAUDE.md trap #4, this is NOT run during a ClickHouse version upgrade, and uses a name
# that has never been touched by one.
#
#   ./infra/create-console-user.sh          # create/update the profile + user, print grants
#   ./infra/create-console-user.sh rotate   # also rotate the password and rewrite .env
#   ./infra/create-console-user.sh verify   # verification only, no writes

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# shellcheck source=lib.sh
source infra/lib.sh
load_env

: "${CLICKHOUSE_URL:?missing in .env}"
: "${CLICKHOUSE_PASSWORD:?missing in .env}"

PROFILE=video_console_profile
USER=video_console
MODE="${1:-apply}"

gen_password() {
    # ClickHouse's password policy wants a special character; `#` keeps it URL-safe enough
    # for a query-string password (which /play uses) without percent-encoding surprises.
    printf '%s#1' "$(openssl rand -base64 18 | tr -d '=+/\n')"
}

verify() {
    local pw="$1"
    log "verify — same-value settings no-op under readonly=1, and the scope is web.assets only"
    local ok200 fail497
    ok200="$(curl -s -o /dev/null -w '%{http_code}' --user "$USER:$pw" \
        "$CLICKHOUSE_URL/?add_http_cors_header=1&enable_http_compression=1&use_query_cache=1&enable_reads_from_query_cache=0&enable_writes_to_query_cache=1&query_cache_ttl=600&query_cache_nondeterministic_function_handling=save&query_cache_system_table_handling=ignore&extremes=1" \
        --data-binary "SELECT count() FROM web.assets")"
    [[ "$ok200" == "200" ]] && ok "play-shaped request against web.assets -> 200" \
        || die "play-shaped request -> HTTP $ok200 (expected 200)"

    fail497="$(curl -s --user "$USER:$pw" "$CLICKHOUSE_URL/" \
        --data-binary "SELECT 1 FROM oltp.pg_saved_sites LIMIT 1")"
    [[ "$fail497" == *"ACCESS_DENIED"* ]] && ok "oltp.* correctly denied (ACCESS_DENIED)" \
        || die "expected oltp.* to be denied, got: $fail497"
}

if [[ "$MODE" == "verify" ]]; then
    : "${CLICKHOUSE_CONSOLE_PASSWORD:?missing in .env — run without 'verify' first}"
    verify "$CLICKHOUSE_CONSOLE_PASSWORD"
    exit 0
fi

log "profile — bake /play's own request settings as defaults (readonly stays CONST)"
ch "
ALTER SETTINGS PROFILE $PROFILE SETTINGS
  readonly = 1 CONST,
  add_http_cors_header = 1,
  enable_http_compression = 1,
  use_query_cache = 1,
  enable_reads_from_query_cache = 0,
  enable_writes_to_query_cache = 1,
  query_cache_ttl = 600,
  query_cache_nondeterministic_function_handling = 'save',
  query_cache_system_table_handling = 'ignore',
  extremes = 1,
  max_execution_time = 10 CONST,
  max_result_rows = 100000 CONST,
  max_rows_to_read = 50000000 CONST
" >/dev/null 2>&1 || ch "
CREATE SETTINGS PROFILE IF NOT EXISTS $PROFILE SETTINGS
  readonly = 1 CONST,
  add_http_cors_header = 1,
  enable_http_compression = 1,
  use_query_cache = 1,
  enable_reads_from_query_cache = 0,
  enable_writes_to_query_cache = 1,
  query_cache_ttl = 600,
  query_cache_nondeterministic_function_handling = 'save',
  query_cache_system_table_handling = 'ignore',
  extremes = 1,
  max_execution_time = 10 CONST,
  max_result_rows = 100000 CONST,
  max_rows_to_read = 50000000 CONST
" >/dev/null
ok "profile $PROFILE"

need_password=0
if [[ "$MODE" == "rotate" || -z "${CLICKHOUSE_CONSOLE_PASSWORD:-}" ]]; then
    need_password=1
fi

if [[ "$need_password" == "1" ]]; then
    PW="$(gen_password)"
    log "user — (re)creating $USER with a fresh password"
    ch "DROP USER IF EXISTS $USER" >/dev/null
    ch "CREATE USER $USER IDENTIFIED WITH sha256_password BY '$PW' SETTINGS PROFILE $PROFILE" >/dev/null
    ch "GRANT SELECT ON web.assets TO $USER" >/dev/null

    if grep -q '^CLICKHOUSE_CONSOLE_PASSWORD=' .env 2>/dev/null; then
        # portable in-place edit (no GNU/BSD sed divergence): rewrite via a temp file
        python3 - "$PW" <<'PY'
import sys, pathlib
pw = sys.argv[1]
p = pathlib.Path(".env")
lines = p.read_text().splitlines(keepends=True)
out = []
for line in lines:
    if line.startswith("CLICKHOUSE_CONSOLE_PASSWORD="):
        out.append(f"CLICKHOUSE_CONSOLE_PASSWORD={pw}\n")
    else:
        out.append(line)
p.write_text("".join(out))
PY
    else
        {
            echo ""
            echo "# Dedicated READONLY user for the demo video's console beat (/play against"
            echo "# web.assets only) — see infra/create-console-user.sh for why this can't be the"
            echo "# 'site' user. Never the default/admin user."
            echo "CLICKHOUSE_CONSOLE_USER=$USER"
            echo "CLICKHOUSE_CONSOLE_PASSWORD=$PW"
        } >> .env
    fi
    ok "user $USER (password written to .env, never printed)"
else
    PW="$CLICKHOUSE_CONSOLE_PASSWORD"
    ch "GRANT SELECT ON web.assets TO $USER" >/dev/null
    ok "user $USER already provisioned (.env has CLICKHOUSE_CONSOLE_PASSWORD) — grants re-applied"
fi

verify "$PW"
ok "done — CLICKHOUSE_CONSOLE_USER=$USER, CLICKHOUSE_CONSOLE_PASSWORD in .env"
