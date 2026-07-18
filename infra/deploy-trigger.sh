#!/usr/bin/env bash
# Stand up a Trigger.dev PRODUCTION deployment of `wherehouse-chat` — so the live app
# (https://app.slim-shaggy.com) works with NO local `pnpm exec trigger dev` process
# running. Before this script existed, the deployed Cloudflare Worker minted tokens
# against a `tr_dev_…` key, so chat only worked while someone's laptop ran `trigger dev`.
#
# Idempotent: re-running re-imports env vars (override), re-deploys the task, re-fetches
# the prod key (it doesn't rotate on its own) and re-puts the Worker secret.
#
#   ./infra/deploy-trigger.sh            # everything: env -> deploy -> key -> rewire -> verify
#   ./infra/deploy-trigger.sh env        # just import required vars into the Trigger prod env
#   ./infra/deploy-trigger.sh deploy     # just `trigger deploy`
#   ./infra/deploy-trigger.sh key        # just fetch the prod secret key into .env
#   ./infra/deploy-trigger.sh rewire     # just point the Cloudflare Worker's secret at prod
#   ./infra/deploy-trigger.sh verify     # curl-only smoke test (does NOT touch local `trigger dev`)
#
# ── Two things this had to discover, not assume (constitution II/III) ──────────────
#
# 1. `trigger deploy` INDEXES every task file in a remote build container as part of the
#    build (an "indexer" step, not just static bundling) — so any `process.env.X` read that
#    happens eagerly at module load, not inside a task run, executes there too. Deploy #1
#    failed with "Postgres CA not found at .secrets/pg-ca.crt" from `web/src/lib/pg.ts`:
#    that module builds its Postgres `Pool` (and reads the CA file) at import time,
#    unconditionally — meaning *every* chat message, not just `saveSite`, would have
#    crashed the deployed task before this was caught. Fixed in `lib/pg.ts`: it now prefers
#    `POSTGRES_CA_CERT` (an env var, set below) over the local file, file read stays as the
#    local-dev fallback. Order matters: env vars must be imported (`env`) *before*
#    `deploy`, since the indexer step reads the current prod environment.
#
# 2. There is no `trigger env set` in the CLI (only list/get/pull) and no CLI subcommand to
#    fetch a project's prod secret key. Both go through the REST API
#    (`POST .../envvars/{env}/import`, `GET .../projects/{ref}/{env}`) — and BOTH reject the
#    short-lived `tr_uat_…` token from `trigger mint-token` ("Invalid or Missing API key",
#    verified against both endpoints). `mint-token`'s docstring — "authenticates as you" —
#    reads like it should work; it doesn't, for these two admin endpoints. Only the raw
#    personal access token (`tr_pat_…`, the same one `trigger login` already stored on this
#    machine) is accepted. So this script reads that token straight out of the CLI's own
#    config file rather than reinventing a login flow — same file `trigger login` writes,
#    resolved the same way its `xdg-app-paths`-based config dir logic does (macOS:
#    `~/Library/Preferences/trigger`; Linux: `$XDG_CONFIG_HOME/trigger` or `~/.config/trigger`).
#
# ── Why the Worker secret is TRIGGER_SECRET_KEY_PROD, not TRIGGER_SECRET_KEY ────────
#
# `.env`'s `TRIGGER_SECRET_KEY` is the `tr_dev_…` key `infra/deploy-app.sh` used to hand the
# Worker before this script existed, and it stays there untouched — it's still what a local
# `pnpm exec trigger dev` authenticates as, and it's the rollback path (see below). This
# script writes the fetched prod key to a SEPARATE `.env` var, `TRIGGER_SECRET_KEY_PROD`,
# and `deploy-app.sh`'s `do_deploy` now puts THAT on the Worker. Keeping them distinct means
# re-running `deploy-app.sh` (e.g. after a UI change) can never silently flip the live
# Worker back to the dev key.
#
# Rollback (if the prod path ever wedges): `wrangler secret put TRIGGER_SECRET_KEY` in
# `infra/app-worker/`, pasting `.env`'s `TRIGGER_SECRET_KEY` (the dev key) — then run
# `pnpm exec trigger dev` locally as before. That path was never touched by this script.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/infra/lib.sh"
load_env

: "${TRIGGER_PROJECT_ID:?missing in .env}"
: "${ANTHROPIC_API_KEY:?missing in .env}"
: "${ANTHROPIC_BASE_URL:?missing in .env}"
: "${LLM_MODEL:?missing in .env}"
: "${CLICKHOUSE_URL:?missing in .env}"
: "${CLICKHOUSE_USER:?missing in .env}"
: "${CLICKHOUSE_PASSWORD:?missing in .env}"
: "${POSTGRES_URL:?missing in .env}"

WEB_DIR="$ROOT/web"
WORKER_DIR="$ROOT/infra/app-worker"
CA_FILE="$ROOT/.secrets/pg-ca.crt"
TRIGGER_API="https://api.trigger.dev"

need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' — $2"; }

preflight() {
    need pnpm "corepack enable, or npm i -g pnpm"
    need python3 "should be on macOS/Linux by default"
    (cd "$WEB_DIR" && pnpm exec trigger whoami >/dev/null 2>&1) \
        || die "trigger CLI not authenticated — run 'cd web && pnpm exec trigger login'"
    [[ -f "$CA_FILE" ]] || die "no $CA_FILE — fetch it per CLAUDE.md's Postgres section first"
}

# The personal access token `trigger login` already stored, for the two REST calls the CLI
# has no subcommand for (env import, fetch prod key). `trigger mint-token`'s tr_uat_ tokens
# are rejected by both endpoints — verified, not assumed; see the comment block above.
trigger_pat() {
    local candidate value
    for candidate in \
        "${XDG_CONFIG_HOME:-}/trigger/config.json" \
        "$HOME/Library/Preferences/trigger/config.json" \
        "$HOME/.config/trigger/config.json"
    do
        [[ -n "$candidate" && -f "$candidate" ]] || continue
        value="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['profiles']['default']['accessToken'])" "$candidate" 2>/dev/null)" || continue
        [[ -n "$value" ]] || continue
        printf '%s\n' "$value"
        return 0
    done
    die "could not find the trigger CLI's stored login (config.json) — run 'cd web && pnpm exec trigger login'"
}

# --- env: import the vars the deployed task reads at runtime -----------------------------

# Grep-derived, not hand-maintained: every `process.env.X` the task (and its imports)
# actually reads. Re-check this list if chat.ts / layers.ts / scoring.ts / lib/pg.ts grow
# new env reads.
do_env() {
    log "importing required vars into the Trigger prod environment"
    local pat
    pat="$(trigger_pat)"
    [[ -n "$pat" ]] || die "could not read the trigger CLI's stored PAT"

    CA_CONTENT="$(cat "$CA_FILE")" \
    python3 - "$pat" "$TRIGGER_PROJECT_ID" "$TRIGGER_API" <<'PY'
import json, os, sys, urllib.request

pat, project_ref, api = sys.argv[1], sys.argv[2], sys.argv[3]

variables = {
    "ANTHROPIC_API_KEY": os.environ["ANTHROPIC_API_KEY"],
    "ANTHROPIC_BASE_URL": os.environ["ANTHROPIC_BASE_URL"],
    "LLM_MODEL": os.environ["LLM_MODEL"],
    "CLICKHOUSE_URL": os.environ["CLICKHOUSE_URL"],
    "CLICKHOUSE_USER": os.environ["CLICKHOUSE_USER"],
    "CLICKHOUSE_PASSWORD": os.environ["CLICKHOUSE_PASSWORD"],
    "POSTGRES_URL": os.environ["POSTGRES_URL"],
    "POSTGRES_CA_CERT": os.environ["CA_CONTENT"],
}
body = json.dumps({"variables": variables, "override": True, "isSecret": True}).encode()
req = urllib.request.Request(
    f"{api}/api/v1/projects/{project_ref}/envvars/prod/import",
    data=body,
    method="POST",
    headers={"Authorization": f"Bearer {pat}", "Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
except urllib.error.HTTPError as e:
    sys.stderr.write(e.read().decode(errors="replace") + "\n")
    raise
if not result.get("success"):
    sys.exit(f"import failed: {result}")
print(f"  imported {len(variables)} variables: {', '.join(sorted(variables))}")
PY
    ok "prod env vars imported"
}

# --- deploy: ship the task -----------------------------------------------------------------

do_deploy() {
    log "deploying wherehouse-chat to Trigger.dev prod (env vars must already be imported)"
    (cd "$WEB_DIR" && pnpm exec trigger deploy)
    ok "trigger deploy finished"
}

# --- key: fetch the prod secret key, write it to .env (TRIGGER_SECRET_KEY_PROD) ------------

do_key() {
    log "fetching the prod secret key"
    local pat key
    pat="$(trigger_pat)"
    [[ -n "$pat" ]] || die "could not read the trigger CLI's stored PAT"

    key="$(curl -sS -H "Authorization: Bearer $pat" \
        "$TRIGGER_API/api/v1/projects/$TRIGGER_PROJECT_ID/prod" \
        | python3 -c "import json,sys; print(json.load(sys.stdin)['apiKey'])")"
    [[ "$key" == tr_prod_* ]] || die "did not get a tr_prod_ key back: $key"

    python3 -c "$(cat <<'PY'
import re, sys
path, key = sys.argv[1], sys.argv[2]
src = open(path).read()
line = f"TRIGGER_SECRET_KEY_PROD={key}\n"
if re.search(r'^TRIGGER_SECRET_KEY_PROD=', src, re.M):
    src = re.sub(r'^TRIGGER_SECRET_KEY_PROD=.*$', line.rstrip("\n"), src, count=1, flags=re.M)
else:
    src = re.sub(r'^(TRIGGER_PROJECT_ID=.*)$', r'\1\n' + line.rstrip("\n"), src, count=1, flags=re.M)
open(path, "w").write(src)
PY
)" "$ROOT/.env" "$key"
    ok "prod key written to .env as TRIGGER_SECRET_KEY_PROD (${key:0:12}…)"
}

# --- rewire: point the Worker's Trigger secret at prod --------------------------------------

do_rewire() {
    load_env  # re-source so TRIGGER_SECRET_KEY_PROD (just written) is in scope
    : "${TRIGGER_SECRET_KEY_PROD:?run './infra/deploy-trigger.sh key' first}"
    need wrangler "pnpm add -g wrangler"
    log "pointing the Worker's TRIGGER_SECRET_KEY at prod"
    (cd "$WORKER_DIR" && printf '%s' "$TRIGGER_SECRET_KEY_PROD" | wrangler secret put TRIGGER_SECRET_KEY)
    ok "Worker now mints tokens against the prod Trigger environment"
}

# --- verify: curl-only, never touches the local 'trigger dev' process -----------------------

verify() {
    log "POST https://app.slim-shaggy.com/api/token"
    local resp
    resp="$(curl -sS --max-time 20 -X POST "https://app.slim-shaggy.com/api/token" \
        -H 'content-type: application/json' -d '{"chatId":"deploy-trigger-verify"}')"
    grep -q '"token"' <<<"$resp" || die "token mint failed: $resp"
    ok "token mint works (against whichever key the Worker currently holds)"
    warn "this does NOT prove the prod task runs — that needs a real chat.agent() run with"
    warn "the local 'trigger dev' process stopped; see docs/PLAN.md for the verification note"
}

# --- main ------------------------------------------------------------------------------------

main() {
    preflight
    case "${1:-}" in
        env) do_env ;;
        deploy) do_deploy ;;
        key) do_key ;;
        rewire) do_rewire ;;
        verify) verify ;;
        "")
            do_env
            do_deploy
            do_key
            do_rewire
            verify
            ;;
        *) die "unknown subcommand '$1' — env|deploy|key|rewire|verify" ;;
    esac
}

main "$@"
