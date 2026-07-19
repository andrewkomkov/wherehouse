#!/usr/bin/env python3
"""
Lay the generated voiceover + soundtrack onto the rendered demo video — no Remotion re-render.

Reads the measured beat timings (video/out/timings.json), places each per-beat VO clip at its
beat's start with a greedy no-overlap rule that self-corrects drift whenever the footage beat is
longer than its line, loops the Lyria soundtrack under everything and ducks it beneath the voice,
then muxes the result onto the captioned MP4 with a straight video copy.

  python mix.py [VIDEO_IN] [VIDEO_OUT]
    VIDEO_IN   default video/remotion/out/wherehouse-demo.mp4  (the captioned Remotion render)
    VIDEO_OUT  default video/out/wherehouse-demo-final.mp4

Needs ffmpeg + ffprobe. VO/music come from ./out (run generate.py first); timings from ../out.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent          # video/voiceover
VIDEO_OUT_DIR = ROOT.parent / "out"             # video/out (capture outputs)
VO_DIR = ROOT / "out" / "vo"
MANIFEST = ROOT / "out" / "vo.manifest.json"
MUSIC = ROOT / "out" / "music.wav"
GAP_MS = 450                                    # breath between spoken lines

VIDEO_IN = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "remotion" / "out" / "wherehouse-demo.mp4"
VIDEO_OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else VIDEO_OUT_DIR / "wherehouse-demo-final.mp4"


def die(msg):
    sys.exit(f"✗ {msg}")


def probe_seconds(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ])
    return float(out.strip())


def main():
    for p in (VIDEO_IN, MANIFEST, MUSIC):
        if not p.exists():
            die(f"missing input: {p}  (run the capture/render and generate.py first)")
    timings_path = VIDEO_OUT_DIR / "timings.json"
    if not timings_path.exists():
        die(f"missing {timings_path} — run the capture (./video/build.sh capture) first")

    timings = json.loads(timings_path.read_text())
    beats = {b["id"]: b for b in timings["beats"]}
    clips = {c["id"]: c for c in json.loads(MANIFEST.read_text())["clips"]}
    vdur = probe_seconds(VIDEO_IN)
    TAIL = 0.3          # leave a beat of silence at the end of each window
    MAX_TEMPO = 1.5     # never speed a line more than this (stays natural)

    # Anchor each line to the START of its beat and, if the line is longer than the beat window,
    # gently speed it (atempo) so it FITS that window. The caption for a beat is on screen for the
    # whole window, so a line pinned inside it is perfectly in sync with its caption — no drift.
    order = [b["id"] for b in timings["beats"] if b["id"] in clips]
    placed = []
    for bid in order:
        b = beats[bid]
        start = b["startMs"] / 1000.0
        window = max(1.0, (b["endMs"] - b["startMs"]) / 1000.0 - TAIL)
        dur = clips[bid]["seconds"]
        tempo = min(MAX_TEMPO, max(1.0, dur / window))
        placed.append((bid, start, dur, tempo))
    print(f"video {vdur:.1f}s · {len(placed)} lines anchored to beats")
    for bid, start, dur, tempo in placed:
        tag = f" ×{tempo:.2f}" if tempo > 1.001 else ""
        print(f"  {bid:9s} @ {start:6.1f}s  ({dur:.1f}s{tag})")

    # Normalise the soundtrack to a clean PCM wav first — Lyria can return mpeg bytes (sometimes
    # mislabelled), which aloop/stream_loop handle unreliably. Transcoding once makes looping exact.
    music_clean = ROOT / "out" / "music.clean.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(MUSIC),
         "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", str(music_clean)],
        check=True,
    )

    # Build the ffmpeg graph: video(0), vo clips(1..N), music(last, input-level looped to cover).
    inputs = ["-i", str(VIDEO_IN)]
    for bid, _, _, _ in placed:
        inputs += ["-i", str(VO_DIR / f"{bid}.wav")]
    inputs += ["-stream_loop", "-1", "-i", str(music_clean)]
    music_idx = len(placed) + 1

    parts, vo_labels = [], []
    for i, (_bid, start, _dur, tempo) in enumerate(placed, start=1):
        d = int(start * 1000)
        tempo_f = f"atempo={tempo:.4f}," if tempo > 1.001 else ""
        # Resample every line to a common 48 kHz up front so amix never has to reconcile the VO's
        # 24 kHz with the music's 44.1 kHz.
        parts.append(f"[{i}:a]aresample=48000,{tempo_f}adelay={d}:all=1[v{i}]")
        vo_labels.append(f"[v{i}]")
    # Pad the voice bus to the full film length (sidechaincompress below ends when its control —
    # the voice — ends, which would otherwise cut the music dead after the last line), then SPLIT
    # it: the voice feeds BOTH the sidechain control and the final mix, and a filter output may
    # only be consumed once, so an explicit asplit is required. (Reusing one label for both silently
    # starves the second consumer — that was burying the voice under the music.)
    parts.append(
        f"{''.join(vo_labels)}amix=inputs={len(placed)}:normalize=0:dropout_transition=0,"
        f"apad=whole_dur={vdur:.3f},asplit=2[vosc][vomix]"
    )
    # Soundtrack: looped input, bounded to the film, resampled to 48 kHz, kept QUIET and at a
    # FIXED gain (~-20 dB) — the voice must always sit clearly on top, so the music level is not
    # normalized. Faded in/out.
    fade_out_at = max(0.0, vdur - 3.0)
    parts.append(
        f"[{music_idx}:a]aresample=48000,atrim=0:{vdur:.3f},asetpts=PTS-STARTPTS,"
        f"volume=0.10,afade=t=in:st=0:d=2,afade=t=out:st={fade_out_at:.3f}:d=3[mus]"
    )
    # Duck the already-quiet music further under the voice, mix, then a gentle LIMITER (not
    # loudnorm) to catch sum peaks. loudnorm's single-pass gain-riding was pumping the sparse
    # voice down and the gaps up — a fixed voice level + fixed quiet music + a limiter is stable
    # and keeps the words clearly in front.
    parts.append("[mus][vosc]sidechaincompress=threshold=0.03:ratio=6:attack=5:release=250[musd]")
    parts.append("[vomix][musd]amix=inputs=2:normalize=0,volume=2dB,alimiter=limit=0.97[aout]")
    filtergraph = ";".join(parts)

    VIDEO_OUT.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-stats",
        *inputs,
        "-filter_complex", filtergraph,
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-shortest", str(VIDEO_OUT),
    ]
    print("▸ muxing audio onto the render…")
    subprocess.run(cmd, check=True)
    print(f"✓ final -> {VIDEO_OUT}  ({probe_seconds(VIDEO_OUT):.1f}s)")


if __name__ == "__main__":
    main()
