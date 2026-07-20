# WhereHouse — demo video scenario

**Target length:** ~3:00 (hard cap 5:00). **Format:** 1920×1080, 60 fps, MP4/H.264.
**Voice:** one narrator, calm and confident. **Rule from the brief:** open *directly* on the
product — no logo intro, no talking head. First frame is the app.

The video is produced by the pipeline in this folder: Playwright drives the **real deployed
app** and records the screen; Remotion composes the footage with lower-third captions and
(later) the voiceover. Each beat below maps 1:1 to an entry in [`beats.json`](beats.json) —
`action` is what Playwright does, `caption` is the on-screen lower-third, `vo` is the narration
(full text in [`voiceover.md`](voiceover.md)). Timings are targets; the capture measures the
real duration of each beat and Remotion syncs captions to that.

---

## Beat sheet

### 1 · Cold open — the question (0:00–0:12)
- **Screen:** the first-visit omnibar. Cursor lands in the box; the question types itself,
  character by character: *"where should I open a bakery in Berlin?"* Enter.
- **Caption:** `Ask in plain words.`
- **VO:** "Where should you open a bakery in Berlin? It's a spatial question — so the answer
  shouldn't be a paragraph. Watch."

### 2 · The map assembles itself (0:12–0:38)
- **Screen:** the omnibar dissolves into the map dashboard. Layers arrive in waves —
  1,460 competitor dots, then the opportunity choropleth fades in, then three ranked pins
  drop, then the 10-minute walk catchment draws itself around the winner as a web of streets —
  each edge coloured by walk-time, bright at the doorstep, fading to the 10-minute fringe — then
  a momentum sparkline.
  The "Agent runs" rail on the left ticks through each tool as it fires.
- **Caption:** `The map is the answer — assembling live from ClickHouse.`
- **VO:** "No wall of text. A Trigger-dot-dev agent calls ClickHouse, tool by tool, and each
  result draws itself onto the map in place — competitors, an opportunity surface, the three
  best sites, a real walking catchment. The model never sees the geometry. It only gets to say
  what the map can't."

### 3 · Why this pick (0:38–1:05)
- **Screen:** focus the #1 pick. The provenance panel opens: **Lichtenrade** — thousands of
  residents, zero bakeries in the surrounding cells, a measured 10-minute walk reach. Then the
  **camera pushes in** — a real MapLibre `fitBounds` on the spider-web (not a video zoom, so
  streets and labels stay crisp and the side rails never clip) — until the reachable **street
  network fills the frame**: the exact 10-minute walk, edge by edge, coloured bright at the
  doorstep and fading to the fringe. This is the shot that makes the VO's "measured against the
  street network" *literal* — you SEE the streets it was measured on. Hold, then ease back to the
  city for the next beat.
- **Caption:** `Lichtenrade — real name, real numbers, nothing invented.`
- **VO:** "The winner is Lichtenrade — a dense residential edge with no bakery nearby. The name
  is resolved from real boundary geometry, the numbers are the ones the score ranked on, and
  the fourteen-thousand-person walk reach was measured by Valhalla against the street network —
  not guessed."

### 4 · The agent operates the UI (1:05–1:30)
- **Screen:** type a follow-up: *"weight walkability to the max."* The agent calls its
  `reweight` tool; the sliders move on their own and the opportunity surface **recolours
  instantly**, client-side, no round-trip.
- **Caption:** `Ask it to re-weight — the agent drives the controls itself.`
- **VO:** "You don't just read the answer — you argue with it. Ask it to weight walkability
  higher, and the agent moves the sliders itself. The surface re-scores in the browser,
  instantly, on the same numbers ClickHouse already sent."

### 5 · Scale — every food & drink venue (1:30–1:52)
- **Screen:** type *"show me all food and drink."* Thousands of points render at once
  (~6,700). A small chip notes the layer streamed via a handle, not the chat.
- **Caption:** `6,700 points — too big for the chat stream, so it isn't in it.`
- **VO:** "And it scales. Every food-and-drink venue in Berlin — thousands of points. Too large
  for the chat stream's one-megabyte limit, so it never touches it: it lands in ClickHouse and
  the browser reads it straight from the database."

### 6 · OLTP × OLAP — your sites vs the market (1:52–2:18)
- **Screen:** open "Your saved sites", click **Compare vs the market**. Saved pins re-score
  against today's surface; the panel fills with each site's live market gap.
- **Caption:** `A saved site, re-scored against 75M live POIs.`
- **VO:** "Save a site and it goes to Postgres. Seconds later, change-data-capture replicates
  it into ClickHouse, where it's re-scored against seventy-five million live points — your own
  data, joined against the whole market, in one query."

### 7 · The stunt — the app is a database row (2:18–2:32)
- **Screen:** cut to the REAL ClickHouse `/play` web console (a separate recording — this is
  not the app), the beat's own query typed in live against `web.assets`, run, and the result
  rows held on screen: `/index.html`, `text/html`, ~28.89 KiB.
- **Caption:** `The whole app is a row in ClickHouse.`
- **VO:** "One last thing — there is no web server. This entire app is a row in ClickHouse.
  Every file, a row you can query."

### 8 · The close (2:32–2:55)
- **Screen:** back to the app, the assembled map, camera pulling back to the full view.
- **Caption:** `Ask a question. Get a map.`
- **VO:** "The agent runs on Trigger-dot-dev's cloud. Ask a question, get a map — not a wall of
  text. That's WhereHouse."

---

## Notes for the editor / voice

- Pace the VO to the **measured** beat durations in `timings.json` after capture — the pipeline
  writes them. If a beat's animation runs long, hold the caption; don't rush the line.
- The only text on screen is the app's own UI plus the lower-third captions. No stock footage,
  no bullet slides — that would be the wall of text the product exists to replace.
- Music: low, minimal, one track under everything, ducked ~6 dB under the voice.
- Accent colour for captions/underlines is the product teal `#6ff0e0`; the #1 pick's highlight
  yellow `#FAFF69` is reserved for the winning pin only, mirroring the app.
