---
name: "wherehouse-video"
description: "Produce the WhereHouse demo video: drive the real app with Playwright, compose with Remotion, generate voice+music with Gemini, mux it all. Carries every hard-won gotcha (fake-4K capture, audio asplit, loudnorm pumping, sidechain music-cut, atempo-fit, multi-source timeline, ClickHouse /play console). Load this before shooting, re-shooting, or debugging the video."
user-invocable: true
disable-model-invocation: false
metadata:
  author: "wherehouse"
  domain: "demo video"
---

# WhereHouse demo video — production runbook

Everything lives in `video/`. The video is **produced from the real app**, not storyboarded:
Playwright drives a running WhereHouse and records the screen; Remotion composes that footage
with lower-third captions + a gentle Ken-Burns camera; Gemini generates the English voiceover and
the soundtrack; ffmpeg muxes audio onto the render. There is a `video-director` agent that owns
running this — this skill is the detailed recipe it (and you) follow.

## The pipeline

```
beats.json  ──▶ capture/capture.mjs ──▶ out/screen.webm + out/console.webm + out/timings.json
 (story:                (Playwright)              │
  captions, zoom,                                 ▼ ffmpeg (build.sh do_convert, -crf 14)
  actions, /play query)                 remotion/public/{screen,console}.mp4 + src/{timings,beats}.json
voiceover/vo.en.json ─▶ voiceover/generate.py ─▶ voiceover/out/vo/*.wav + out/music.wav
 (narration text)          (Gemini TTS + Lyria)             │
                                                   remotion/ ──▶ out/wherehouse-demo.mp4  (silent, --crf 16)
                                                   (captions + zoom, 60fps)   │
                                          voiceover/mix.py (ffmpeg) ──▶ out/wherehouse-demo-final.mp4
                                          (VO anchored per beat + ducked music, muxed — NO re-render)
```

`./video/build.sh` runs capture → convert → render. `beats.json` is the **single source of truth**
(captions, per-beat `zoom`, capture `action`, the console `query`) read by BOTH capture and render.
`mix.py` is the audio pass — it muxes onto the finished render, so re-timing audio never needs a
re-render.

## THE GOTCHAS — each cost real time this session. Read before touching the pipeline.

### 1. "4K" capture is a lie unless you force it at the Chromium process level
`deviceScaleFactor: 2` + `recordVideo.size: {3840,2160}` does **NOT** produce 4K. Playwright's
`recordVideo` captures at the CSS-viewport pixel size regardless of `deviceScaleFactor`; the real
content lands in the top-left 1920×1080 of the 3840×2160 canvas with the rest solid grey — a video
*labelled* 4K that is secretly 1080p (and then any zoom upscales → blur). The working fix:
```js
chromium.launch({ args: ["--force-device-scale-factor=2", "--high-dpi-support=1"] });
context = browser.newContext({ viewport: {1920,1080}, recordVideo: { size: {3840,2160} } });
```
Keep the viewport at 1920×1080 (the app's layout is designed for it — a bigger viewport shrinks the
rails). VERIFY the master with `ffprobe` (3840×2160) **and** by pixel-sampling that content fills the
frame — don't trust the labelled resolution.

### 2. Zoom clips a side rail — the dashboard has TWO of them, so the demo ships STATIC (no zoom)
The Ken-Burns rig exists and works (`kenBurns()` in `Video.tsx`, per-beat `"zoom": {fx,fy,s0,s1}` in
`beats.json`, capped at 2.0× since the 4K master is native-1:1 at 2.0× and blurs past it). But the app
is a full-bleed dashboard with a LEFT rail (Agent runs) and a RIGHT rail (Top picks / sliders), and the
product owner's rule is **neither rail nor the agent's answer may ever be cropped**. The crop math for
`transform-origin:(fx,fy); scale(s)`: the visible original-x window is `[fx·(1−1/s), fx+(1−fx)/s]`. A
CENTERED zoom clips *both* edges; even `s≈1.10` shaves the first 1–2 characters off the left "Agent runs"
rail. Anchoring left (`fx→0`) saves the left rail but eats the right one — you cannot keep both while
zooming, and a zoom subtle enough to keep both (`s≤~1.01`) is invisible. **So the decision was: no zoom.**
Keep all beats at `s0=s1=1.0` (static full-frame); the movement in the film is the app assembling itself
plus the smooth cross-beat fades. If you re-introduce the REMOTION zoom, it clips a rail — get the owner's
sign-off first. (Changing only the zoom to 1.0 needs a re-RENDER + re-mix, NOT a re-capture — the footage is
unchanged; `remotion render` + `mix.py`.)

**The deep zoom into the pick DOES exist now — but it is a real MAP camera move at CAPTURE time, not the
Remotion scale.** `capture.mjs`'s `focusTopPick` drives `window.__whMap.fitBounds(<catchment bounds>)` (the
map handle exposed in `chat.tsx`) to push the live MapLibre camera into the top pick's spider-web, hold, then
`easeTo` back to the city. Because only the map VIEWPORT moves — not the whole 4K frame — the two side rails
and the captions never clip, which is exactly the constraint that killed the Remotion Ken-Burns. Streets and
labels re-render crisp (vector zoom, not upscaled pixels). This is baked into `screen.webm`, so changing it
needs a **re-CAPTURE** (unlike the Remotion zoom). Tune the push in `zoomToCatchment`/`focusTopPick`
(duration, `maxZoom`, hold). It no-ops safely if `__whMap` or the `catchment` source isn't present.

### 3. Captions and the brand bug are OUTPUT-resolution overlays — never zoom them
Only the `<OffthreadVideo>` gets the zoom transform. Captions (`Captions.tsx`) and `BrandBug` sit on
top at 1080p and must not scale/pan with the footage. Caption position is `bottom: 232` — raised
deliberately so it clears the app's OWN bottom-left answer caption + provenance chips (at `bottom:96`
they overlapped). Do not regress that.

### 4. Audio mixing — five separate landmines in one ffmpeg graph (`mix.py`)
The voice was inaudible for two rounds because of these. All are in `voiceover/mix.py`:
- **`asplit` the voice bus.** The voice feeds BOTH the sidechain control (to duck music) AND the final
  amix. A filter output may be consumed ONCE — reusing `[vo]` in two places silently starves the
  second consumer and buries the voice ~13 dB. Must `...[vo]; [vo]asplit=2[vosc][vomix]`.
- **No `loudnorm` on the final mix.** loudnorm's single-pass gain-riding pumps sparse voice: it lifts
  the music in the gaps and ducks the voice as it enters. Use FIXED levels + a gentle `alimiter`
  instead (voice ~−20 dB, music ~−30 dB, ≥8 dB apart; final `volume=2dB,alimiter=limit=0.97`).
- **`apad` the voice bus to the full duration.** `sidechaincompress` ends when its sidechain (the
  voice) ends → the music cuts dead the moment the last line finishes. Pad: `...amix,apad=whole_dur={vdur}`.
- **Transcode the music before looping.** Lyria returns **mpeg** bytes (sometimes mislabelled `.wav`);
  `aloop`/`-stream_loop` handle it unreliably. `ffmpeg -i music.wav -c:a pcm_s16le -ar 44100` to a clean
  WAV first, then `-stream_loop -1`.
- **Resample everything to 48 kHz before amix.** VO clips are 24 kHz, music 44.1 kHz — `aresample=48000`
  on each input so amix never reconciles rates. Final AAC at `-ar 48000`.

### 5. Sync the voice to the footage with atempo-fit, not by hoping
`mix.py` anchors each VO clip to its beat's measured `startMs` and, if the line is longer than the beat
window, gently speeds it (`atempo`, capped 1.5×) so it FITS the window — the caption is on screen for
the whole window, so a line pinned inside it stays in sync with its caption, no drift. **If a line needs
>1.4× it sounds rushed** → don't ship it; trim the text in `vo.en.json` and regenerate just that clip
(`generate.py vo <id>`), then re-run `mix.py` (no re-render). Gemini's Zephyr reads at ~2 words/s, so
budget ~2 words per second of window when writing a line.

### 6. Voice + music generation (Gemini)
`voiceover/generate.py` (needs `GEMINI_API_KEY` in `.env`):
- `vo` — one clip per beat from `vo.en.json`, model `gemini-2.5-pro-preview-tts`, voice **Zephyr**.
  Per-beat clips (not one long read) so each line sits at its beat's measured start. Selective regen:
  `generate.py vo ask reweight`.
- `music` — one soundtrack bed, model `lyria-3-pro-preview`.
Gemini TTS returns quiet audio — that's fine, `mix.py` sets absolute levels. The text source of truth is
`vo.en.json`; keep it in step with `voiceover.md` (the human script + RU variant).

### 7. Multi-source timeline — inserting a clip that's a separate recording
The console beat is footage of a DIFFERENT screen (ClickHouse `/play`), captured separately as
`console.webm`, INSERTED between `compare` and `close` on the timeline (do NOT navigate the main app page
to /play — it destroys the assembled map the `close` beat needs). Model it with per-beat source info in
`timings.json`: each beat carries `source: "app"|"console"` and `sourceInMs` (offset within that source
file). `Video.tsx` then renders ONE `<Sequence>` per beat, each with its own
`<OffthreadVideo src={source==='console'?console:screen} startFrom={ms2f(sourceInMs)}>` — not one
composition-spanning video. The app's `close` footage plays from its recorded (post-compare) position
while the inserted console fills the gap.

### 8. Use ClickHouse `/play`, NOT the Cloud console, for a "web console" beat
The ClickHouse Cloud dashboard sits behind reCAPTCHA/bot-detection and short-lived (5-min) OAuth tokens —
do not automate it (bot-detection bypass is off-limits, and it breaks mid-shoot). The native web console
`${CLICKHOUSE_URL}/play` is a real ClickHouse console, authenticated by DB creds, no login/CAPTCHA.
Selectors: `#url`, `#user`, `#password`, `#query`, `#run`. Use the **`site`** readonly user
(`CLICKHOUSE_SITE_USER`/`CLICKHOUSE_SITE_PASSWORD`) — never the default/admin. The demo query proves the
app is rows in the DB: `SELECT path, content_type, formatReadableSize(length(body)) FROM web.assets WHERE
content_type LIKE 'text/html%'` → `/index.html · text/html · ~28.89 KiB`.

### 9. Encode quality + 60 fps kill the artifacts
The dense red competitor-dot field blocks up at default CRF. Encode near-lossless at every step:
`do_convert` webm→mp4 at `-crf 14 -preset slow`, Remotion render at `--crf 16`. `beats.json` `meta.fps=60`
→ the composition renders 60 fps (smooth Ken-Burns camera + captions). Playwright's screencast may cap the
underlying app-footage fps below 60 — that's an accepted limit; the 60 fps timeline + clean encode is what
delivers the "smooth and beautiful".

### 10. Never fake footage; shoot the DEPLOYED app
Every frame is the real deployed app (`https://app.slim-shaggy.com`) assembling a real answer, and the
console beat is a real query. If a category/UI change must show, deploy it first (`deploy-trigger.sh` /
`deploy-app.sh`) so the video is provably the shipped product. Check `./infra/check-env.sh` (DeepSeek
balance — each agent beat spends it — and app 200) before a take.

## Verify every take (pull frames from the FINAL mp4 and READ them)
- ffprobe: master 3840×2160; final 1920×1080, 60 fps, H.264 + AAC 48 kHz, ~110-125 s.
- Zoom keeps the agent visible: a `pick`/`reweight` frame shows the left rail AND the map, uncropped.
- No artifacts: a `scale` frame's dot-field is clean, not blocky.
- Console beat: shows /play with the real query + `web.assets` result rows legible.
- Audio: voice clearly in front of the music (mean ~−20 dB), no rushed line (mix.py prints per-beat tempo).

## File map
`video/beats.json` (story+zoom+actions), `video/build.sh` (pipeline), `video/capture/capture.mjs`
(Playwright), `video/remotion/src/{Root,Video,Captions}.tsx` (compose), `video/voiceover/{vo.en.json,
generate.py,mix.py}` (audio), `video/scenario.md` + `video/voiceover.md` (human script, EN+RU). Heavy
artifacts (mp4/wav/webm, node_modules, .venv) are gitignored; the scripts + text are the tracked truth.
