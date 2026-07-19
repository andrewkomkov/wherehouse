#!/usr/bin/env bash
#
# Speed up the finished demo uniformly — picture AND voice together, so captions stay in sync
# (they are baked into the video frames) and the pitch is preserved (atempo). The Gemini Zephyr
# voice reads deliberately (~2 words/s); a ~1.15× global speed makes the film punchier without
# sounding chipmunky.
#
#   ./video/speedup.sh            # 1.15x (default)
#   ./video/speedup.sh 1.25       # snappier
#
# In:  video/out/wherehouse-demo-final.mp4   (the captioned render WITH audio)
# Out: video/out/wherehouse-demo-fast.mp4
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN="$ROOT/out/wherehouse-demo-final.mp4"
OUT="$ROOT/out/wherehouse-demo-fast.mp4"
F="${1:-1.15}"

[ -f "$IN" ] || { echo "no $IN — run the render+mix first" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }

echo "▸ speeding ${F}x  (video setpts + audio atempo, pitch-preserved, CRF 16)"
ffmpeg -y -loglevel error -stats -i "$IN" \
  -filter_complex "[0:v]setpts=PTS/${F}[v];[0:a]atempo=${F}[a]" \
  -map "[v]" -map "[a]" \
  -c:v libx264 -crf 16 -preset slow -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 192k -ar 48000 \
  "$OUT"

dur() { ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$1"; }
printf "✓ %s  (%.1fs -> %.1fs)\n" "$OUT" "$(dur "$IN")" "$(dur "$OUT")"
