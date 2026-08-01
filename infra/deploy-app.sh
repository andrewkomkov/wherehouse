#!/usr/bin/env bash
# ADR-003 "for real": build the app as a static export, load it into ClickHouse
# (`web.assets`, one row per file), and deploy the Cloudflare Worker that serves those
# bytes to the browser and fronts the three server-side operations (Trigger.dev public
# token, chat-session start, saved-site write) that used to be Next.js Server Actions.
#
# Idempotent: re-running rebuilds, re-truncates+reloads web.assets, and redeploys the
# Worker with its secrets. Auth: wrangler OAuth (`wrangler login`) for Cloudflare, `.env`
# for ClickHouse.
#
#   ./infra/deploy-app.sh              # everything: build -> load -> deploy -> verify
#   ./infra/deploy-app.sh build        # just the static export
#   ./infra/deploy-app.sh load         # just (re)load web/out/ into ClickHouse
#   ./infra/deploy-app.sh deploy       # just `wrangler deploy` (+ secrets)
#   ./infra/deploy-app.sh verify       # live GET + token mint + a real round-trip save
#
# ── Why a Cloudflare Worker is in front at all ──
#
# The static export has NO server runtime (no Server Actions, no API routes) — that's the
# whole point of shipping it as ClickHouse rows. Three operations still need a secret
# server-side: minting a Trigger.dev public token, starting a chat session, and writing a
# saved site. All three were proven to work from workerd BEFORE this script was written
# (constitution III):
#
#   - Token mint + session start: `@trigger.dev/sdk`'s `auth.createPublicToken` and
#     `@trigger.dev/sdk/ai`'s `chat.createStartSessionAction` are pure `fetch` + local
#     HS256 JWT signing (`jose`, WebCrypto) — no raw TCP. Verified live: a deployed Worker
#     minted a real token and started a real chat.agent session/run against the live
#     Trigger.dev API (session/run ids confirmed, then cancelled for cleanliness).
#
#   - Saved-site write: one HTTPS POST to ClickHouse as the narrow `app_writer` user
#     (INSERT/SELECT on `app.saved_sites` and nothing else). `verify` below proves it end
#     to end on every deploy with a canary row it then deletes.
#
# This script used to also provision a Cloudflare CA-certificate upload and a Hyperdrive
# config, because saved sites lived in a managed Postgres whose private Ubicloud CA raw
# `cloudflare:sockets` could not validate (ADR-004). ADR-005 moved that state into
# ClickHouse, which the Worker reaches over ordinary public-CA HTTPS — so the `provision`
# subcommand, the two-roots-in-the-bundle diagnosis it automated, and the Hyperdrive
# binding are all gone. `git log` has them if that path is ever needed again.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/infra/lib.sh"
load_env

: "${CLICKHOUSE_URL:?missing in .env}"
: "${CLICKHOUSE_PASSWORD:?missing in .env}"
: "${CLICKHOUSE_APP_WRITER_PASSWORD:?missing in .env — the app_writer password (ADR-005)}"
: "${TRIGGER_SECRET_KEY_PROD:?missing in .env — run ./infra/deploy-trigger.sh key first}"

WEB_DIR="$ROOT/web"
WORKER_DIR="$ROOT/infra/app-worker"
WORKER_NAME="wherehouse-app"
HOSTNAME_PUBLIC="app.slim-shaggy.com"

need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' — $2"; }

preflight() {
    need pnpm "corepack enable, or npm i -g pnpm"
    need wrangler "pnpm add -g wrangler"
    need python3 "should be on macOS/Linux by default"
    wrangler whoami >/dev/null 2>&1 || die "wrangler not authenticated — run 'wrangler login'"
}

# --- build --------------------------------------------------------------------------

do_build() {
    log "building static export (next build, output: export)"
    (cd "$WEB_DIR" && pnpm build)
    [[ -d "$WEB_DIR/out" ]] || die "no web/out — build did not produce a static export"
    ok "static export ready: $(du -sh "$WEB_DIR/out" | cut -f1) ($(find "$WEB_DIR/out" -type f | wc -l | tr -d ' ') files)"
}

# --- load into ClickHouse -------------------------------------------------------------

do_load() {
    log "ensuring web.assets exists"
    apply_sql_file "$ROOT/db/clickhouse/009_app_assets_schema.sql"

    # The saved-site store the Worker writes and the browser reads (ADR-005). Idempotent
    # (CREATE ... IF NOT EXISTS + a GRANT), so it costs nothing to keep it in step with the
    # bundle it serves. NB the GRANT is access DDL — never run this mid-version-upgrade
    # (CLAUDE.md trap #4).
    log "ensuring app.saved_sites exists"
    apply_sql_file "$ROOT/db/clickhouse/014_saved_sites.sql"

    [[ -d "$WEB_DIR/out" ]] || die "no web/out — run './infra/deploy-app.sh build' first"

    log "truncating web.assets (redeploy replaces the whole bundle)"
    ch "TRUNCATE TABLE web.assets" >/dev/null

    log "loading web/out/ into web.assets (single RowBinary INSERT)"
    local count
    count="$(CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" \
        python3 - "$WEB_DIR/out" <<'PY'
import base64
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

out_dir = sys.argv[1]
url = os.environ["CLICKHOUSE_URL"]
password = os.environ["CLICKHOUSE_PASSWORD"]

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".map": "application/json; charset=utf-8",
    ".pbf": "application/x-protobuf",
}


def content_type(path):
    _, ext = os.path.splitext(path)
    return MIME.get(ext, "application/octet-stream")


def write_varint(buf, n):
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            buf.append(b | 0x80)
        else:
            buf.append(b)
            return


def write_string(buf, data: bytes):
    write_varint(buf, len(data))
    buf.extend(data)


payload = bytearray()
count = 0
for root, _dirs, files in os.walk(out_dir):
    for name in files:
        full = os.path.join(root, name)
        rel = "/" + os.path.relpath(full, out_dir).replace(os.sep, "/")
        with open(full, "rb") as f:
            body = f.read()
        write_string(payload, rel.encode("utf-8"))
        write_string(payload, body)
        write_string(payload, content_type(rel).encode("utf-8"))
        count += 1

# ClickHouse HTTP interface: the query goes in the URL, the RowBinary payload is the POST body.
query = "INSERT INTO web.assets (path, body, content_type) FORMAT RowBinary"
full_url = url + "/?" + urllib.parse.urlencode({"query": query})
req = urllib.request.Request(full_url, data=bytes(payload), method="POST")
req.add_header(
    "Authorization",
    "Basic " + base64.b64encode(f"default:{password}".encode()).decode(),
)
try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        resp.read()
except urllib.error.HTTPError as e:
    sys.stderr.write(e.read().decode(errors="replace") + "\n")
    raise

print(count)
PY
    )"
    ok "loaded $count files into web.assets"
}

# --- deploy the Worker -----------------------------------------------------------------

do_deploy() {
    log "installing app-worker deps"
    (cd "$WORKER_DIR" && pnpm install --silent)

    log "deploying $WORKER_NAME"
    (cd "$WORKER_DIR" && wrangler deploy)

    log "setting Worker secrets (idempotent — always re-put)"
    # TRIGGER_SECRET_KEY_PROD, not TRIGGER_SECRET_KEY (the tr_dev_… key `trigger dev` uses
    # locally) — see infra/deploy-trigger.sh for why they're kept separate: this Worker is
    # the ONE thing the public site talks to, and it must mint prod-scoped tokens so chat
    # works with no local `trigger dev` process running.
    (cd "$WORKER_DIR" && printf '%s' "$TRIGGER_SECRET_KEY_PROD" | wrangler secret put TRIGGER_SECRET_KEY)
    (cd "$WORKER_DIR" && printf '%s' "$CLICKHOUSE_SITE_PASSWORD" | wrangler secret put CLICKHOUSE_SITE_PASSWORD)
    # The write credential (ADR-005). Scoped to INSERT/SELECT on app.saved_sites — never the
    # `default` password, which would put an admin credential in a Worker.
    (cd "$WORKER_DIR" && printf '%s' "$CLICKHOUSE_APP_WRITER_PASSWORD" | wrangler secret put CLICKHOUSE_APP_WRITER_PASSWORD)
    ok "$WORKER_NAME deployed with secrets set"
}

# --- verify ------------------------------------------------------------------------------

# Right after `wrangler deploy` / `wrangler secret put`, the very first request or two can
# 500 while the new version propagates across Cloudflare's edge (observed consistently
# during development — resolves within ~10s). Retry a handful of times before treating it
# as a real failure.
curl_retry() {
    local url="$1" method="${2:-GET}" data="${3:-}" code
    for _ in 1 2 3 4 5; do
        if [[ -n "$data" ]]; then
            code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X "$method" \
                -H 'content-type: application/json' -d "$data" "$url")"
        else
            code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X "$method" "$url")"
        fi
        [[ "$code" == "200" ]] && { echo "$code"; return 0; }
        sleep 3
    done
    echo "$code"
}

verify() {
    log "GET https://$HOSTNAME_PUBLIC/"
    local code
    code="$(curl_retry "https://$HOSTNAME_PUBLIC/")"
    [[ "$code" == "200" ]] || die "GET / -> HTTP $code (expected 200)"
    ok "page loads: HTTP $code"

    log "POST /api/token"
    local token_resp
    token_resp="$(curl -sS --max-time 20 -X POST "https://$HOSTNAME_PUBLIC/api/token" \
        -H 'content-type: application/json' -d '{"chatId":"deploy-verify"}')"
    grep -q '"token"' <<<"$token_resp" || die "POST /api/token did not return a token: $token_resp"
    ok "token mint works"

    # The save path, for real: POST a canary row through the Worker, read it back as the
    # PUBLIC `site` user (which is how the panel reads it — so this proves the grant too),
    # then delete it. A 200 from the endpoint alone would not prove the row landed.
    log "POST /api/save-site (canary round-trip)"
    local canary save_resp found
    canary="deploy-verify canary"
    save_resp="$(curl -sS --max-time 20 -X POST "https://$HOSTNAME_PUBLIC/api/save-site" \
        -H 'content-type: application/json' \
        -d "{\"city\":\"berlin\",\"category\":\"deploy-verify\",\"label\":\"$canary\",\"lon\":13.4,\"lat\":52.5,\"h3_8\":\"881f1d4881fffff\",\"score\":null}")"
    grep -q '"ok":true' <<<"$save_resp" || die "POST /api/save-site failed: $save_resp"

    found="$(curl -sS --max-time 20 \
        "$CLICKHOUSE_URL/?user=${CLICKHOUSE_SITE_USER}&password=$(python3 -c 'import urllib.parse,os;print(urllib.parse.quote(os.environ["CLICKHOUSE_SITE_PASSWORD"]))')" \
        --data-binary "SELECT count() FROM app.saved_sites FINAL WHERE label = '$canary'")"
    [[ "$found" == "1" ]] || die "canary row not readable as the site user (got '$found') — INSERT or GRANT broken"

    ch "ALTER TABLE app.saved_sites DELETE WHERE label = '$canary'" >/dev/null
    ok "saved-site write round-trip works (canary written, read back as 'site', deleted)"
}

# --- main --------------------------------------------------------------------------------

main() {
    preflight
    case "${1:-}" in
        build) do_build ;;
        load) do_load ;;
        deploy) do_deploy ;;
        verify) verify ;;
        "")
            do_build
            do_load
            do_deploy
            verify
            ;;
        *) die "unknown subcommand '$1' — build|load|deploy|verify" ;;
    esac
}

main "$@"
