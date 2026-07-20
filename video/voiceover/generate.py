#!/usr/bin/env python3
"""
Generate the WhereHouse demo VOICEOVER (English) and SOUNDTRACK via the Gemini API.

  python generate.py vo       # per-beat English narration -> out/vo/<id>.wav  (+ manifest)
  python generate.py music    # a single minimal soundtrack -> out/music.wav
  python generate.py all      # both

Voiceover: gemini-2.5-pro-preview-tts, voice Zephyr, one clip per beat in vo.en.json, so each
line can be placed at its beat's measured start time in Remotion. Soundtrack: lyria-3-pro-preview.
Needs GEMINI_API_KEY in the environment (kept in the gitignored .env).
"""
import json
import mimetypes
import os
import struct
import sys
import time
import wave
from pathlib import Path

from google import genai
from google.genai import types

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
# City-aware overrides (default = Berlin, so the single-city path is unchanged when unset):
# WH_VO_SPEC picks which vo.<city>.en.json to read, WH_VO_SUBDIR names the output wav dir.
VO_SPEC = ROOT / os.environ.get("WH_VO_SPEC", "vo.en.json")
VO_DIR = OUT / os.environ.get("WH_VO_SUBDIR", "vo")
VO_MANIFEST = OUT / os.environ.get("WH_VO_MANIFEST", "vo.manifest.json")


def parse_audio_mime_type(mime_type: str) -> dict:
    bits_per_sample, rate = 16, 24000
    for param in mime_type.split(";"):
        param = param.strip()
        if param.lower().startswith("rate="):
            try:
                rate = int(param.split("=", 1)[1])
            except (ValueError, IndexError):
                pass
        elif param.startswith("audio/L"):
            try:
                bits_per_sample = int(param.split("L", 1)[1])
            except (ValueError, IndexError):
                pass
    return {"bits_per_sample": bits_per_sample, "rate": rate}


def to_wav(audio: bytes, mime_type: str) -> bytes:
    p = parse_audio_mime_type(mime_type)
    bps, rate, ch = p["bits_per_sample"], p["rate"], 1
    block_align = ch * bps // 8
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + len(audio), b"WAVE", b"fmt ", 16, 1, ch, rate,
        rate * block_align, block_align, bps, b"data", len(audio),
    )
    return header + audio


def collect_audio(client, model, contents, config, retries=3):
    """Stream a generate call and concatenate all inline audio, returning (bytes, mime)."""
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            buf, mime = bytearray(), None
            for chunk in client.models.generate_content_stream(
                model=model, contents=contents, config=config
            ):
                if not chunk.parts:
                    continue
                inline = chunk.parts[0].inline_data
                if inline and inline.data:
                    buf += inline.data
                    mime = mime or inline.mime_type
            if buf and mime:
                return bytes(buf), mime
            last_err = RuntimeError("no audio in response")
        except Exception as e:  # noqa: BLE001
            last_err = e
        wait = 2 * attempt
        print(f"  retry {attempt}/{retries} in {wait}s ({str(last_err)[:120]})")
        time.sleep(wait)
    raise last_err


def wav_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return round(w.getnframes() / float(w.getframerate()), 2)


def gen_vo(client, only=None):
    spec = json.loads(VO_SPEC.read_text())
    VO_DIR.mkdir(parents=True, exist_ok=True)
    style = spec.get("style", "")
    # Preserve any already-generated clips not being regenerated, so the manifest stays complete.
    existing = {}
    mpath = VO_MANIFEST
    if mpath.exists():
        existing = {c["id"]: c for c in json.loads(mpath.read_text()).get("clips", [])}
    manifest = []
    for beat in spec["beats"]:
        if only and beat["id"] not in only:
            if beat["id"] in existing:
                manifest.append(existing[beat["id"]])
            continue
        bid, text = beat["id"], beat["text"]
        prompt = f"{style}\n\n{text}" if style else text
        print(f"▸ vo/{bid}")
        audio, mime = collect_audio(
            client,
            spec["model"],
            [types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
            types.GenerateContentConfig(
                temperature=1,
                response_modalities=["audio"],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=spec["voice"])
                    )
                ),
            ),
        )
        ext = mimetypes.guess_extension(mime) or ""
        data = audio if ext == ".wav" else to_wav(audio, mime)
        out = VO_DIR / f"{bid}.wav"
        out.write_bytes(data)
        dur = wav_seconds(out)
        print(f"  saved {out.name} ({dur}s, {len(data)//1024} KiB)")
        manifest.append({"id": bid, "file": f"vo/{bid}.wav", "seconds": dur})
    VO_MANIFEST.write_text(json.dumps({"clips": manifest}, indent=2))
    total = round(sum(c["seconds"] for c in manifest), 1)
    print(f"✓ voiceover: {len(manifest)} clips, {total}s total -> {OUT/'vo.manifest.json'}")


def gen_music(client):
    OUT.mkdir(parents=True, exist_ok=True)
    prompt = (
        "A minimal, calm, modern ambient underscore for a data/tech product demo. "
        "Soft analog synth pads, a gentle pulsing arpeggio, subtle low sub-bass, no drums or a very "
        "light heartbeat kick, spacious and unobtrusive. Hopeful and precise, not epic. It should sit "
        "quietly under a narrator's voice. Around 90 BPM, in a warm minor key."
    )
    print("▸ music (lyria-3-pro-preview)")
    audio, mime = collect_audio(
        client,
        "lyria-3-pro-preview",
        [types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
        types.GenerateContentConfig(response_modalities=["audio"]),
    )
    ext = mimetypes.guess_extension(mime) or ".wav"
    data = audio if ext == ".wav" else to_wav(audio, mime)
    out = OUT / "music.wav"
    out.write_bytes(data)
    try:
        print(f"✓ music: {wav_seconds(out)}s -> {out}")
    except Exception:
        print(f"✓ music saved ({len(data)//1024} KiB, mime {mime}) -> {out}")


def main():
    stage = sys.argv[1] if len(sys.argv) > 1 else "all"
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit("GEMINI_API_KEY not set (source ../../.env)")
    only = set(sys.argv[2:]) or None  # e.g. `generate.py vo ask reweight compare`
    client = genai.Client(api_key=key)
    if stage in ("vo", "all"):
        gen_vo(client, only)
    if stage in ("music", "all"):
        gen_music(client)


if __name__ == "__main__":
    main()
