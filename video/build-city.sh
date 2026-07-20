#!/usr/bin/env bash
#
# Build ONE city's demo video end-to-end against the deployed app:
#   saved-sites hygiene  ->  capture  ->  convert  ->  render  ->  mix (that city's VO)  ->  speed-up
#   =>  video/out/wherehouse-<city>-final.mp4
#
#   ./video/build-city.sh berlin
#   ./video/build-city.sh amsterdam
#   ./video/build-city.sh belgrade
#   SPEED=1.15 ./video/build-city.sh berlin        # override the final speed-up (default 1.12x)
#   APP_URL=http://localhost:3000 ./video/build-city.sh berlin
#
# Why a wrapper: the base pipeline (build.sh / generate.py / mix.py) is single-city (Berlin).
# This selects the city's beat sheet + VO (via the WH_VO_* env overrides), makes the saved-sites
# panel city-consistent (no more Belgrade/Amsterdam rows in the Berlin cut), and speeds the whole
# cut up a touch (the narration read slow). The city VO must already exist under
# voiceover/out/vo-<city>/ + vo.manifest.<city>.json (generate.py makes them).
set -euo pipefail

CITY="${1:?usage: build-city.sh <berlin|amsterdam|belgrade>}"
SPEED="${SPEED:-1.10}"
APP_URL="${APP_URL:-https://app.slim-shaggy.com}"
# REMIX=1 skips the (balance-spending) capture+render and re-mixes the saved silent render
# out/render-<city>.mp4 with the current VO — for a VO-text / speed tweak with the SAME footage.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # video/
cd "$ROOT"

log() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

case "$CITY" in
  berlin)    BEATS=beats.berlin.json;    VODIR=vo;           VOMAN=vo.manifest.json ;;
  amsterdam) BEATS=beats.amsterdam.json; VODIR=vo-amsterdam; VOMAN=vo.manifest.amsterdam.json ;;
  belgrade)  BEATS=beats.belgrade.json;  VODIR=vo-belgrade;  VOMAN=vo.manifest.belgrade.json ;;
  *) die "unknown city '$CITY' (berlin|amsterdam|belgrade)" ;;
esac

[ -f "voiceover/out/$VODIR/close.wav" ] || die "no VO for $CITY (voiceover/out/$VODIR) — run generate.py first"
[ -f "voiceover/out/$VOMAN" ] || die "no VO manifest voiceover/out/$VOMAN — run generate.py first"

# --- .env (POSTGRES_URL for saved-sites hygiene) ------------------------------------------------
envfile="$ROOT/../.env"
# shellcheck disable=SC1090
[ -f "$envfile" ] && { set -a; . "$envfile"; set +a; } || die "no .env"
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
CA="$ROOT/../.secrets/pg-ca.crt"
psql_do() { psql "${POSTGRES_URL}&sslmode=verify-full&sslrootcert=${CA}" -v ON_ERROR_STOP=1 "$@"; }

render="out/render-${CITY}.mp4"   # saved silent render, so a VO-only tweak can re-mix for free

if [ -n "${REMIX:-}" ]; then
  # --- REMIX: reuse the saved silent render, skip the balance-spending capture+render ------------
  [ -f "$render" ] || die "REMIX set but no saved render at $render — run a full build for $CITY first"
  log "REMIX — reusing saved render $render (no capture, no render)"
else
  # --- 1. saved-sites hygiene: make the "YOUR SAVED SITES" panel city-consistent -----------------
  # The demo user u1's saves are shared across cities; unscoped, a Berlin cut shows Belgrade's
  # Rakovica and Amsterdam's Nieuw-West. Berlin's beat sheet uses focusTopPick (no auto-save) so it
  # needs its own Berlin saves left in place; Amsterdam/Belgrade use focusTopPickAndSave, which
  # creates their save live during the capture, so they start from empty.
  log "saved-sites hygiene for $CITY"
  if [ "$CITY" = "berlin" ]; then
    psql_do -c "DELETE FROM public.saved_sites WHERE user_id='u1' AND label IN ('Rakovica','Nieuw-West, Amsterdam')"
  else
    psql_do -c "DELETE FROM public.saved_sites WHERE user_id='u1'"
  fi
  log "waiting 15s for ClickPipes CDC to carry that to ClickHouse before the compare beat re-scores…"
  sleep 15

  # --- 2. stage the city's beat sheet as the active beats.json (build.sh reads beats.json) -------
  cp "$BEATS" beats.json
  log "staged $BEATS -> beats.json"

  # --- 3. capture + convert + render against the deployed app -----------------------------------
  APP_URL="$APP_URL" ./build.sh
  cp remotion/out/wherehouse-demo.mp4 "$render"          # keep the silent render for future re-mix
  cp out/timings.json "out/timings.${CITY}.json"          # its measured windows, for future re-mix
fi

# --- 4. mix this city's VO onto the render (city-aware via WH_VO_* overrides) --------------------
# mix.py reads the measured windows from out/timings.json — in REMIX mode restore this city's.
[ -n "${REMIX:-}" ] && cp "out/timings.${CITY}.json" out/timings.json
mixed="out/wherehouse-${CITY}-mixed.mp4"
log "mixing $CITY VO ($VODIR) + music"
WH_VO_DIR="$ROOT/voiceover/out/$VODIR" WH_VO_MANIFEST="$VOMAN" \
  voiceover/.venv/bin/python voiceover/mix.py "$render" "$mixed"

# --- 5. speed the whole cut up a touch (video + audio together, kept in sync) --------------------
final="out/wherehouse-${CITY}-final.mp4"
log "speed-up ${SPEED}x -> $final"
ffmpeg -y -loglevel error -i "$mixed" \
  -vf "setpts=PTS/${SPEED}" -af "atempo=${SPEED}" \
  -c:v libx264 -crf 16 -preset slow -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 192k -ar 48000 "$final"
rm -f "$mixed"

dur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$final")"
printf '\033[32m✓ %s -> %s  (%.1fs)\033[0m\n' "$CITY" "$final" "$dur"
