#!/usr/bin/env bash
# ADR-003 "for real": build the app as a static export, load it into ClickHouse
# (`web.assets`, one row per file), and deploy the Cloudflare Worker that serves those
# bytes to the browser and fronts the three server-side operations (Trigger.dev public
# token, chat-session start, Postgres save/list) that used to be Next.js Server Actions.
#
# Idempotent: re-running rebuilds, re-truncates+reloads web.assets, re-provisions the
# Cloudflare CA cert / Hyperdrive config only if missing (by name), and redeploys the
# Worker. Auth: wrangler OAuth (`wrangler login`) for Cloudflare, `.env` for ClickHouse.
#
#   ./infra/deploy-app.sh              # everything: build -> load -> provision -> deploy -> verify
#   ./infra/deploy-app.sh build        # just the static export
#   ./infra/deploy-app.sh load         # just (re)load web/out/ into ClickHouse
#   ./infra/deploy-app.sh provision    # just the CA cert + Hyperdrive config (idempotent)
#   ./infra/deploy-app.sh deploy       # just `wrangler deploy` (+ secrets)
#   ./infra/deploy-app.sh verify       # live GET against the custom domain + a chat smoke test
#
# ── Why a Cloudflare Worker is in front at all, and why Postgres needs Hyperdrive ──
#
# The static export has NO server runtime (no Server Actions, no API routes) — that's the
# whole point of shipping it as ClickHouse rows. Three operations still need a secret
# server-side: minting a Trigger.dev public token, starting a chat session, and
# reading/writing the OLTP saved-site history. All three were proven to work from workerd
# BEFORE this script was written (constitution III):
#
#   - Token mint + session start: `@trigger.dev/sdk`'s `auth.createPublicToken` and
#     `@trigger.dev/sdk/ai`'s `chat.createStartSessionAction` are pure `fetch` + local
#     HS256 JWT signing (`jose`, WebCrypto) — no raw TCP. Verified live: a deployed Worker
#     minted a real token and started a real chat.agent session/run against the live
#     Trigger.dev API (session/run ids confirmed, then cancelled for cleanliness).
#
#   - Postgres: raw `cloudflare:sockets` (`pg`'s own `pg-cloudflare` support) completes the
#     TCP + Postgres SSLRequest handshake fine, but the TLS upgrade (`startTls()`) closes
#     itself asynchronously ~1s later — Cloudflare's Sockets API validates only against
#     public root CAs, with no custom-CA option, and our managed Postgres presents a
#     private Ubicloud-issued CA (same root cause as the documented `psql sslmode=require`
#     failure). Hyperdrive DOES support a custom CA (`--ca-certificate-id`) and this was
#     verified end-to-end on a real deployed Worker: 4/4 requests returned real
#     `saved_sites` rows. This script automates exactly that provisioning.
#
#   - The CA bundle at .secrets/pg-ca.crt holds TWO root certs (an old/new pair, both
#     currently valid) — only ONE actually signs the live Postgres leaf cert. Uploading
#     the wrong one (or both concatenated) makes Hyperdrive fail with
#     "certificate signature failure [BAD_SIGNATURE]" at config-creation time, which reads
#     like a bad CA when it's actually the wrong (but real, valid) root. This script picks
#     the right one the same way that was diagnosed: `openssl verify` each candidate
#     against the live leaf cert fetched via `openssl s_client -starttls postgres`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/infra/lib.sh"
load_env

: "${CLICKHOUSE_URL:?missing in .env}"
: "${CLICKHOUSE_PASSWORD:?missing in .env}"
: "${POSTGRES_HOST:?missing in .env}"
: "${POSTGRES_USER:?missing in .env}"
: "${POSTGRES_PASSWORD:?missing in .env}"
: "${POSTGRES_DB:?missing in .env}"
: "${TRIGGER_SECRET_KEY_PROD:?missing in .env — run ./infra/deploy-trigger.sh key first}"

WEB_DIR="$ROOT/web"
WORKER_DIR="$ROOT/infra/app-worker"
CA_CERT_NAME="wherehouse-pg-ca"
HYPERDRIVE_NAME="wherehouse-pg-hyperdrive"
WORKER_NAME="wherehouse-app"
HOSTNAME_PUBLIC="app.slim-shaggy.com"
CA_CACHE="${TMPDIR:-/tmp}/wherehouse-pg-ca-correct.pem"

need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' — $2"; }

preflight() {
    need pnpm "corepack enable, or npm i -g pnpm"
    need wrangler "pnpm add -g wrangler"
    need python3 "should be on macOS/Linux by default"
    need openssl "should be on macOS/Linux by default"
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

# --- provision Cloudflare (idempotent by name) ----------------------------------------

# The CA bundle has two roots (old/new); only one signs the live leaf. Pick it the same
# way the mismatch was originally diagnosed.
resolve_correct_ca() {
    local bundle="$ROOT/.secrets/pg-ca.crt"
    [[ -f "$bundle" ]] || die "no .secrets/pg-ca.crt — fetch it per CLAUDE.md's Postgres section first"

    local tmpdir leaf i
    tmpdir="$(mktemp -d)"
    trap 'rm -rf "$tmpdir"' RETURN

    awk -v d="$tmpdir" 'BEGIN{c=0} /BEGIN CERTIFICATE/{c++} {print > (d "/cand" c ".pem")}' "$bundle"

    leaf="$tmpdir/leaf.pem"
    echo | openssl s_client -connect "$POSTGRES_HOST:5432" -starttls postgres -showcerts 2>/dev/null \
        | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' | head -20 > "$leaf"
    [[ -s "$leaf" ]] || die "could not fetch the live Postgres leaf cert via openssl s_client"

    for i in "$tmpdir"/cand*.pem; do
        if openssl verify -CAfile "$i" "$leaf" >/dev/null 2>&1; then
            cp "$i" "$CA_CACHE"
            return 0
        fi
    done
    die "none of the CA bundle's certs verify the live Postgres leaf — CA may have rotated; re-fetch .secrets/pg-ca.crt"
}

cert_id_by_name() {
    wrangler cert list 2>/dev/null | python3 -c "$(cat <<'PY'
import sys
name = sys.argv[1]
lines = sys.stdin.read().splitlines()
cur_id = None
for line in lines:
    line = line.strip()
    if line.startswith("ID:"):
        cur_id = line.split("ID:", 1)[1].strip()
    elif line.startswith("Name:") and line.split("Name:", 1)[1].strip() == name:
        print(cur_id or "")
        break
PY
)" "$1"
}

hyperdrive_id_by_name() {
    wrangler hyperdrive list 2>/dev/null | python3 -c "$(cat <<'PY'
import sys
name = sys.argv[1]
for line in sys.stdin.read().splitlines():
    if "│" not in line:
        continue
    cols = [c.strip() for c in line.split("│")]
    if len(cols) > 2 and cols[2] == name:
        print(cols[1])
        break
PY
)" "$1"
}

do_provision() {
    local ca_id hd_id

    ca_id="$(cert_id_by_name "$CA_CERT_NAME")"
    if [[ -z "$ca_id" ]]; then
        log "CA cert '$CA_CERT_NAME' not found — resolving the correct root and uploading"
        resolve_correct_ca
        ca_id="$(wrangler cert upload certificate-authority --ca-cert "$CA_CACHE" --name "$CA_CERT_NAME" 2>&1 \
            | grep -o 'ID: [a-f0-9-]*' | head -1 | cut -d' ' -f2)"
        [[ -n "$ca_id" ]] || die "CA cert upload did not report an ID"
        ok "uploaded CA cert '$CA_CERT_NAME': $ca_id"
    else
        ok "CA cert '$CA_CERT_NAME' already exists: $ca_id"
    fi

    hd_id="$(hyperdrive_id_by_name "$HYPERDRIVE_NAME")"
    if [[ -z "$hd_id" ]]; then
        log "Hyperdrive config '$HYPERDRIVE_NAME' not found — creating"
        hd_id="$(wrangler hyperdrive create "$HYPERDRIVE_NAME" \
            --origin-host "$POSTGRES_HOST" --origin-port 5432 \
            --database "$POSTGRES_DB" --origin-user "$POSTGRES_USER" --origin-password "$POSTGRES_PASSWORD" \
            --origin-scheme postgres \
            --ca-certificate-id "$ca_id" \
            --sslmode verify-full 2>&1 | tee /dev/stderr | grep -o '"id": "[a-f0-9]*"' | head -1 | cut -d'"' -f4)"
        [[ -n "$hd_id" ]] || die "Hyperdrive creation did not report an ID"
        ok "created Hyperdrive config '$HYPERDRIVE_NAME': $hd_id"
    else
        ok "Hyperdrive config '$HYPERDRIVE_NAME' already exists: $hd_id"
    fi

    # Keep wrangler.toml's binding id in sync (idempotent rewrite).
    python3 -c "$(cat <<'PY'
import re, sys
path, new_id = sys.argv[1], sys.argv[2]
src = open(path).read()
src2 = re.sub(r'(\[\[hyperdrive\]\][^\[]*id = ")[a-f0-9]+(")', r'\g<1>' + new_id + r'\g<2>', src, count=1)
if src2 != src:
    open(path, "w").write(src2)
    print("updated")
else:
    print("unchanged")
PY
)" "$WORKER_DIR/wrangler.toml" "$hd_id"
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
    ok "$WORKER_NAME deployed with secrets set"
}

# --- verify ------------------------------------------------------------------------------

# Right after `wrangler deploy` / `wrangler secret put`, the very first request or two can
# 500 while the new version propagates across Cloudflare's edge (observed consistently
# during development — resolves within ~10s). Retry a handful of times before treating it
# as a real failure.
curl_retry() {
    local url="$1" method="${2:-GET}" data="${3:-}" i code
    for i in 1 2 3 4 5; do
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

    log "GET /api/list-saved"
    local list_code
    list_code="$(curl_retry "https://$HOSTNAME_PUBLIC/api/list-saved")"
    [[ "$list_code" == "200" ]] || die "GET /api/list-saved -> HTTP $list_code"
    ok "postgres (via Hyperdrive) reachable from the Worker"
}

# --- main --------------------------------------------------------------------------------

main() {
    preflight
    case "${1:-}" in
        build) do_build ;;
        load) do_load ;;
        provision) do_provision ;;
        deploy) do_deploy ;;
        verify) verify ;;
        "")
            do_build
            do_load
            do_provision
            do_deploy
            verify
            ;;
        *) die "unknown subcommand '$1' — build|load|provision|deploy|verify" ;;
    esac
}

main "$@"
