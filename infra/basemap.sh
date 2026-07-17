#!/usr/bin/env bash
# Basemap pipeline: cut city extracts from the Protomaps daily planet build, push them
# to R2, and deploy the Protomaps worker that serves /{name}/{z}/{x}/{y}.mvt.
#
# Idempotent: re-running re-uses an existing local extract and overwrites the R2 object.
# Force a re-cut with FORCE=1.
#
#   ./infra/basemap.sh              # everything: extract -> upload -> deploy -> verify
#   ./infra/basemap.sh extract      # just cut the local .pmtiles
#   ./infra/basemap.sh upload       # just push to R2
#   ./infra/basemap.sh deploy       # just deploy the worker
#   ./infra/basemap.sh verify       # live GET against the custom domain
#
# Auth: wrangler OAuth (`wrangler login`). Note `wrangler whoami` does NOT list an r2
# scope, yet R2 calls succeed — the scope list is not authoritative, so we probe.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/infra/lib.sh"

BUCKET="wherehouse-basemaps"
HOSTNAME_PUBLIC="wherehouse.slim-shaggy.com"
WORKER_DIR="$ROOT/infra/basemap-worker"
BUILD_DIR="${BUILD_DIR:-$ROOT/.basemap}"   # gitignored: .pmtiles are build artifacts

# City extracts. bbox is lon_min,lat_min,lon_max,lat_max (Protomaps/Overture order —
# NOT the lat-first order geoToH3 wants; see CLAUDE.md trap 1).
# name|bbox|maxzoom
CITIES=(
    "berlin|13.088,52.338,13.761,52.675|14"
)

# --- helpers -----------------------------------------------------------------

need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' — $2"; }

preflight() {
    need pmtiles "brew install pmtiles"
    need wrangler "pnpm add -g wrangler"
    wrangler whoami >/dev/null 2>&1 || die "wrangler not authenticated — run 'wrangler login'"
    wrangler r2 bucket list >/dev/null 2>&1 \
        || die "R2 unreachable with the current token — needs an R2-capable Cloudflare auth"
}

# The daily planet builds expire after ~a week, so the date is resolved at run time.
# There is no listing endpoint on build.protomaps.com — probe backwards from today.
resolve_build() {
    local d code i
    for i in $(seq 0 9); do
        d="$(date -u -v-"${i}"d +%Y%m%d 2>/dev/null || date -u -d "-$i days" +%Y%m%d)"
        code="$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 \
            "https://build.protomaps.com/$d.pmtiles")"
        if [[ "$code" == "206" || "$code" == "200" ]]; then
            printf '%s\n' "$d"
            return 0
        fi
    done
    die "no Protomaps daily build found in the last 10 days"
}

# --- steps -------------------------------------------------------------------

do_extract() {
    local build city name bbox maxzoom out
    build="$(resolve_build)"
    log "protomaps daily build: $build"
    mkdir -p "$BUILD_DIR"

    for city in "${CITIES[@]}"; do
        IFS='|' read -r name bbox maxzoom <<<"$city"
        out="$BUILD_DIR/$name.pmtiles"

        if [[ -f "$out" && -z "${FORCE:-}" ]]; then
            ok "$name.pmtiles exists ($(du -h "$out" | cut -f1)) — FORCE=1 to re-cut"
            continue
        fi

        log "cutting $name z0-$maxzoom from $build …"
        pmtiles extract "https://build.protomaps.com/$build.pmtiles" "$out" \
            --bbox="$bbox" --maxzoom="$maxzoom" --download-threads=8

        # A truncated archive still has a valid header, so assert a real tile decodes.
        pmtiles show "$out" >/dev/null || die "$name.pmtiles is not a readable archive"
        ok "$name.pmtiles $(stat -f%z "$out" 2>/dev/null || stat -c%s "$out") bytes"
    done
}

do_upload() {
    local city name out
    wrangler r2 bucket create "$BUCKET" 2>/dev/null && ok "created bucket $BUCKET" \
        || log "bucket $BUCKET already exists"

    for city in "${CITIES[@]}"; do
        IFS='|' read -r name _ _ <<<"$city"
        out="$BUILD_DIR/$name.pmtiles"
        [[ -f "$out" ]] || die "no $out — run './infra/basemap.sh extract' first"

        log "uploading $name.pmtiles → r2://$BUCKET"
        wrangler r2 object put "$BUCKET/$name.pmtiles" \
            --file "$out" --content-type application/octet-stream --remote >/dev/null
        ok "uploaded $name.pmtiles"
    done
}

do_deploy() {
    log "deploying worker (custom domain $HOSTNAME_PUBLIC)"
    ( cd "$WORKER_DIR" && pnpm install --silent && wrangler deploy )
    ok "worker deployed"
}

# Live checks. A deploy reporting success proves nothing about tiles being served.
do_verify() {
    local city name url code ctype bytes tilejson
    for city in "${CITIES[@]}"; do
        IFS='|' read -r name _ _ <<<"$city"

        tilejson="https://$HOSTNAME_PUBLIC/$name.json"
        code="$(curl -s -o /dev/null -w '%{http_code}' "$tilejson")"
        [[ "$code" == "200" ]] || die "TileJSON $tilejson -> HTTP $code"
        ok "TileJSON 200: $tilejson"

        # z14 tile over central Berlin — must be a non-trivial protobuf, not an empty 204.
        url="https://$HOSTNAME_PUBLIC/$name/14/8802/5373.mvt"
        # The trailing newline is load-bearing: without it `read` hits EOF, returns
        # non-zero and `set -e` kills the script before any check runs.
        read -r code ctype bytes < <(curl -s -o /dev/null \
            -w '%{http_code} %{content_type} %{size_download}\n' "$url")
        [[ "$code" == "200" ]] || die "tile $url -> HTTP $code"
        [[ "$ctype" == "application/x-protobuf" ]] || die "tile $url -> content-type $ctype"
        [[ "$bytes" -gt 1000 ]] || die "tile $url -> only $bytes bytes, archive likely broken"
        ok "tile 200 $ctype ${bytes}B: $url"
    done
}

# --- main --------------------------------------------------------------------

main() {
    preflight
    case "${1:-all}" in
        extract) do_extract ;;
        upload)  do_upload ;;
        deploy)  do_deploy ;;
        verify)  do_verify ;;
        all)     do_extract; do_upload; do_deploy; do_verify ;;
        *)       die "usage: $0 [all|extract|upload|deploy|verify]" ;;
    esac
}

main "$@"
