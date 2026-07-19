# WhereHouse demo video

The demo is **produced from the real app**, not storyboarded by hand. Playwright drives a
running WhereHouse and records the screen; a SEPARATE Playwright recording drives the real
ClickHouse `/play` web console for the "stunt" beat (never staged inside the app recording —
that would disturb the assembled map the closing beat needs). Remotion composes both source
videos, one `<Sequence>` per beat, with lower-third captions synced to the beat timings the
capture measured. Voiceover is dubbed afterward.

```
beats.json  ──▶  capture/capture.mjs  ──▶  out/screen.webm  (7 app beats, continuous)
 (the story)        (Playwright)      ──▶  out/console.webm (1 beat: real ClickHouse /play)
                                       ──▶  out/timings.json (per-beat source + sourceInMs)
                                                    │
                                                    ▼  ffmpeg (crf 14, near-lossless)
scenario.md   ◀── the human-readable script     remotion/public/{screen,console}.mp4
voiceover.md  ◀── the narration (EN + RU)        remotion/src/timings.json
                                                    │
                                       remotion/  ──▶  out/wherehouse-demo.mp4  (crf 16, 60fps)
                                       (one Sequence per beat: its own source + Ken-Burns
                                        + caption; brand bug; fades)
```

## One command

```sh
# 1. point at a real app (deployed is best once the landing is live):
export APP_URL=https://app.slim-shaggy.com
# …or run it locally in another terminal: cd web && pnpm dev  (then APP_URL defaults to :3000)

# 2. shoot + compose:
./build.sh                 # capture -> convert -> render
```

Individual stages: `./build.sh capture`, `./build.sh convert`, `./build.sh render`.

Output: `remotion/out/wherehouse-demo.mp4`.

## Files

| File | What |
|---|---|
| `scenario.md` | Shot-by-shot beat sheet (human-facing) |
| `voiceover.md` | Narration, English + Russian, plus the submission-form text |
| `beats.json` | Machine-readable beats — the source of truth capture **and** render share. The active city's sheet; the pipeline reads this one |
| `beats.amsterdam.json` / `beats.belgrade.json` | Per-city beat sheets (coffee shop / gym). `cp beats.<city>.json beats.json` before a run to shoot that city; `beats.json` itself is the Berlin default |
| `voiceover/vo.amsterdam.en.json` / `vo.belgrade.en.json` | Per-city narration; `cp` onto `voiceover/vo.en.json` then `generate.py vo` before mixing that city |
| `capture/capture.mjs` | Playwright: drives the app + the ClickHouse `/play` console per `beats.json`, records both, measures/stitches timings |
| `infra/create-console-user.sh` | Provisions the dedicated READONLY user the console beat drives `/play` as (never `site` — see the script) |
| `remotion/` | Remotion composition: footage + synced captions + brand |
| `build.sh` | The pipeline: capture → ffmpeg convert → Remotion render |

## Directing it

There is a subagent — **`video-director`** (`.claude/agents/`) — that owns shooting,
re-shooting, and re-cutting. It knows to prefer the deployed app, to check DeepSeek balance
before a take (the agent-driven beats cost tokens and hit live ClickHouse), and to re-run a
thin take rather than fake footage.

## Requirements

- Node 20+, `ffmpeg` on PATH (`brew install ffmpeg`).
- The capture installs its own Chromium via `playwright install`.
- Remotion renders with a bundled headless Chromium; the first render downloads it.

## Voiceover & soundtrack (generated)

The English narration and the music are generated with the Gemini API and mixed onto the
finished render — no Remotion re-render. Everything lives in `voiceover/`.

```sh
cd voiceover
python3 -m venv .venv && ./.venv/bin/pip install google-genai   # first time
export GEMINI_API_KEY=…            # kept in the gitignored ../../.env

./.venv/bin/python generate.py all # per-beat VO (Gemini TTS, voice Zephyr) + music (Lyria)
./.venv/bin/python mix.py          # lay VO on beat starts (atempo-fit) + ducked music -> final
```

- **`vo.en.json`** — the narration text, one line per beat (the audio source of truth; keep it in
  step with `voiceover.md`). Regenerate a few lines with `generate.py vo ask reweight compare`.
- **`generate.py`** — `vo` makes one clip per beat so each line can sit at its beat's measured
  start; `music` makes one soundtrack bed.
- **`mix.py`** — reads the measured `../out/timings.json`, anchors each line to its beat and
  gently speeds any over-long line to fit the beat window (so voice stays in sync with its
  caption), loops + ducks the music under the voice at a fixed quiet level (not loudnorm —
  its single-pass gain-riding was pumping a sparse voice track), and muxes onto
  `remotion/out/wherehouse-demo.mp4` with a straight video copy.

**Output: `out/wherehouse-demo-final.mp4`** — the captioned render *with* voice and music.
Re-run `mix.py` any time the render or the timings change; it never re-renders the picture.
