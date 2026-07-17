#!/usr/bin/env bash
# Shared helpers for the ClickHouse Cloud REST API.
# Everything WhereHouse runs on is provisioned through this API — no console clicking.
# Sourced by provision.sh / teardown.sh / status.sh.

set -euo pipefail

API="https://api.clickhouse.cloud/v1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- env ---------------------------------------------------------------------

load_env() {
    if [[ ! -f "$ROOT/.env" ]]; then
        die "no .env — copy .env.example and fill it in"
    fi
    # shellcheck disable=SC1091
    set -a; source "$ROOT/.env"; set +a

    : "${CLICKHOUSE_API_KEY_ID:?missing in .env}"
    : "${CLICKHOUSE_API_KEY_SECRET:?missing in .env}"
}

# --- output ------------------------------------------------------------------

log()  { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# --- api ---------------------------------------------------------------------

# api <METHOD> <PATH> [JSON_BODY]
# Fails loudly on non-2xx instead of silently returning an error document —
# swallowing errors cost us real debugging time on day 1.
api() {
    local method="$1" path="$2" body="${3:-}"
    local args=(-s -w '\n%{http_code}' -X "$method"
                -u "$CLICKHOUSE_API_KEY_ID:$CLICKHOUSE_API_KEY_SECRET")
    [[ -n "$body" ]] && args+=(-H "Content-Type: application/json" -d "$body")

    local out code
    out="$(curl "${args[@]}" "$API$path")"
    code="$(tail -n1 <<<"$out")"
    out="$(sed '$d' <<<"$out")"

    if [[ ! "$code" =~ ^2 ]]; then
        warn "$method $path -> HTTP $code"
        printf '%s\n' "$out" >&2
        return 1
    fi
    printf '%s\n' "$out"
}

jq_r() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null || true; }

# Wait until a resource reports the desired state.
# wait_state <describe-cmd> <python-path-to-state> <target> <label>
wait_state() {
    local cmd="$1" path="$2" target="$3" label="$4"
    local i state
    for i in $(seq 1 40); do
        state="$(eval "$cmd" | jq_r "$path")"
        [[ "$state" == "$target" ]] && { ok "$label: $state"; return 0; }
        case "$state" in Failed|failed|error) die "$label entered state '$state'";; esac
        printf '\r  %s: %s (%ds)   ' "$label" "${state:-?}" $((i * 15))
        sleep 15
    done
    echo
    die "$label did not reach '$target' in time"
}
