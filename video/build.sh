#!/usr/bin/env bash
#
# WhereHouse demo video — one command: capture the real app, then compose the final MP4.
#
#   ./video/build.sh                         # drive http://localhost:3000 (start `pnpm dev` first)
#   APP_URL=https://app.slim-shaggy.com ./video/build.sh   # drive the deployed site
#   ./video/build.sh capture                 # just record the screen + timings
#   ./video/build.sh render                  # just compose (re-uses the last capture)
#
# Stages: capture (Playwright) -> convert (ffmpeg webm->mp4) -> render (Remotion).
# Output: video/remotion/out/wherehouse-demo.mp4
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAP="$ROOT/capture"
REM="$ROOT/remotion"
OUT="$ROOT/out"
STAGE="${1:-all}"
APP_URL="${APP_URL:-http://localhost:3000}"

log() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

pm() { if have pnpm; then pnpm "$@"; else npm "$@"; fi; }

do_capture() {
  log "capture — driving $APP_URL"
  # The console beat (action "chConsole") drives the real ClickHouse /play console — it
  # needs CLICKHOUSE_URL / CLICKHOUSE_CONSOLE_USER / CLICKHOUSE_CONSOLE_PASSWORD from .env
  # (infra/create-console-user.sh provisions that user; never the default/admin one).
  local envfile="$ROOT/../.env"
  if [ -f "$envfile" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$envfile"
    set +a
  else
    log "! no .env found at $envfile — console beat will be skipped if run"
  fi
  ( cd "$CAP" && [ -d node_modules ] || pm install )
  ( cd "$CAP" && APP_URL="$APP_URL" node capture.mjs )
  [ -f "$OUT/screen.webm" ] || die "no footage produced ($OUT/screen.webm)"
  [ -f "$OUT/timings.json" ] || die "no timings produced"
}

do_convert() {
  have ffmpeg || die "ffmpeg not found — 'brew install ffmpeg'"
  log "convert — webm -> mp4 (near-lossless: crf 14, preset slow — the dense dot-field beats"
  log "  block up under the old default ~23 crf; this keeps them clean)"
  mkdir -p "$REM/public"
  ffmpeg -y -loglevel error -i "$OUT/screen.webm" \
    -c:v libx264 -crf 14 -preset slow -pix_fmt yuv420p -movflags +faststart \
    "$REM/public/screen.mp4"
  if [ -f "$OUT/console.webm" ]; then
    ffmpeg -y -loglevel error -i "$OUT/console.webm" \
      -c:v libx264 -crf 14 -preset slow -pix_fmt yuv420p -movflags +faststart \
      "$REM/public/console.mp4"
  else
    log "! no $OUT/console.webm — console beat will show black/hold-last-frame"
  fi
  cp "$OUT/timings.json" "$REM/src/timings.json"
  cp "$ROOT/beats.json" "$REM/src/beats.json"
  log "footage + measured timings + beat sheet (captions/zoom) staged into remotion/"
}

do_render() {
  log "render — Remotion compose"
  ( cd "$REM" && [ -d node_modules ] || pm install )
  ( cd "$REM" && npx remotion render Demo out/wherehouse-demo.mp4 --codec=h264 --crf=16 )
  log "done -> $REM/out/wherehouse-demo.mp4"
}

case "$STAGE" in
  capture) do_capture ;;
  convert) do_convert ;;
  render)  do_render ;;
  all)     do_capture; do_convert; do_render ;;
  *) die "unknown stage '$STAGE' (capture|convert|render|all)" ;;
esac
