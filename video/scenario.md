# WhereHouse — demo video scenario

**Target length:** ~3:00 (hard cap 5:00). **Format:** 1920×1080, 60 fps, MP4/H.264.
**Voice:** one narrator — confident, brisk, even. **Rule from the brief:** open *directly* on the
product — no logo intro, no talking head. First frame is the app.

The video is produced by the pipeline in this folder: Playwright drives the **real app** and
records the screen; Remotion composes the footage with lower-third captions; Gemini generates the
voiceover and soundtrack; ffmpeg muxes. Each beat maps 1:1 to an entry in [`beats.json`](beats.json)
— `action` is what Playwright does, `caption` is the on-screen lower-third, and the narration lives
in [`voiceover.md`](voiceover.md) / `voiceover/vo.en.json`. Timings are targets; capture measures the
real duration of each beat and the mix syncs the voice to it.

**The spine of this cut (new):** WhereHouse is not a calculator that returns one answer — it is a
**consultant you can interrogate**. After the first ranked answer, the film shows the agent changing
its *mind*, not just its colours: the biggest markets, the places to avoid, one neighbourhood at a
time. That is the beat sheet's centre of gravity (beats 4–6), framed by the technical stunts that win
the rubric (ClickHouse assembling the map, the 1 MiB cap, OLTP×OLAP, the app-is-a-DB-row trick).

---

## Beat sheet

### 1 · Cold open — the question (~0:00)
- **Screen:** the first-visit omnibar. The question types itself: *"where should I open a bakery in
  Berlin?"* Enter.
- **Caption:** `Ask in plain words.`
- **VO:** "Where should you open a bakery in Berlin? Watch the answer draw itself."

### 2 · The map assembles itself (~0:11)
- **Screen:** the omnibar dissolves into the dashboard. Layers arrive in waves — 1,460 competitor
  dots, the opportunity choropleth, three ranked pins, then the 10-minute walk catchment as a web of
  streets, then a momentum sparkline. The left "Agent runs" rail ticks through each tool.
- **Caption:** `The map is the answer — assembling live from ClickHouse.`
- **VO:** "No wall of text. A Trigger-dot-dev agent calls ClickHouse, tool by tool, and every result
  paints itself onto the map — rivals, an opportunity surface, the three best sites, a real
  ten-minute walk. The model never touches the geometry; it only says what the map cannot."

### 3 · Why this pick (~0:35)
- **Screen:** focus the #1 pick; the provenance panel opens (**Lichtenrade**). The **live map camera
  pushes in** on the spider-web (a real `fitBounds`, not a video zoom, so streets stay crisp and the
  rails never clip) until the reachable street network fills the frame, then eases back.
- **Caption:** `Lichtenrade — real name, real numbers, a measured walk.`
- **VO:** "The top site is Lichtenrade — a dense residential edge with no bakery near it. The name is
  real boundary geometry. The numbers are the ones the score ranked on. And that
  fourteen-thousand-person walk was measured by Valhalla, on the actual streets. Not guessed."

### 4 · Not a calculator — a consultant (~0:59)  ★ the turn
- **Screen:** type *"show me the biggest markets even if competitive."* The pins **jump** off the quiet
  edges into the dense, contested inner blocks; a lens badge reads **biggest markets**. The coloured
  surface stays the balanced opportunity — the pins are chasing the population mass now.
- **Caption:** `Change the question, not the weights — the biggest markets, even if crowded.`
- **VO:** "But is that the only answer? No. This isn't a calculator — it's a consultant. Ask for the
  biggest markets instead, and the pins jump to the densest, most contested blocks in the city."

### 5 · Where NOT to open (~1:19)
- **Screen:** type *"where should I avoid opening one?"* The pins move to the most **saturated** cells
  — 60-plus bakeries packed around one block, gap zero; the badge reads **avoid · saturated**.
- **Caption:** `Where NOT to open — the most saturated turf, flagged.`
- **VO:** "Ask where NOT to open, and it flags the saturated turf — sixty-plus bakeries already packed
  around one block. A good consultant rules places out, too."

### 6 · Down to one neighbourhood (~1:37)
- **Screen:** type *"show me the six best spots in Neukölln."* Six ranked pins land inside Neukölln
  alone; the badge reads **in Neukölln**. Every pin is a real district name, none invented.
- **Caption:** `Down to one neighbourhood — six ranked spots inside Neukölln.`
- **VO:** "Or narrow the whole question to one neighbourhood — the six best spots inside Neukölln
  alone, each named from real geometry, none of them invented. Local advice, from the same live data."

### 7 · Scale — every food & drink venue (~1:57)
- **Screen:** type *"show me all food and drink."* Thousands of points render at once; a chip notes
  the layer streamed via a handle, not the chat.
- **Caption:** `Thousands of points — too big for the chat stream, so it isn't in it.`
- **VO:** "And it scales. Every food-and-drink venue in Berlin — thousands of points, too big for the
  chat stream's one-megabyte cap. So it never enters it: it lands in ClickHouse, read straight from
  the browser."

### 8 · OLTP × OLAP — your site vs the market (~2:17)
- **Screen:** open "Your saved sites" → **Compare vs the market**. The saved pin re-scores against
  today's surface; the panel fills with its live market gap.
- **Caption:** `A saved site, re-scored against 75M live points.`
- **VO:** "Save a site and it goes to Postgres. Seconds later, change-data-capture streams it into
  ClickHouse, re-scored against seventy-five million live points — your own data against the whole
  market, in one query."

### 9 · The stunt — the app is a database row (~2:39)
- **Screen:** cut to the real ClickHouse `/play` console (a separate recording); the query runs
  against `web.assets`, result rows held on screen: `/index.html`, `text/html`, ~28.89 KiB.
- **Caption:** `The whole app is a row in ClickHouse.`
- **VO:** "One last thing — there's no web server. The entire app is a row in ClickHouse. Every file,
  a row you can query."

### 10 · The close (~2:53)
- **Screen:** back to the assembled map, held.
- **Caption:** `Ask a question. Get a map.`
- **VO:** "Ask a question, get a live map — not a wall of text. A consultant you can argue with, drawn
  from millions of points. That's WhereHouse."

---

## Notes for the editor / voice

- **Even pacing is the rule.** Every line is sized to ~1.9 words per second of its beat window, so the
  read is uniform — brisk and clear, never draggy, never rushed. `mix.py` prints a per-beat tempo; if
  any line needs > ~1.35×, trim it in `vo.en.json` and regenerate just that clip.
- The consultant beats (4–6) each ride the generic `ask` action — no new capture code — because the
  agent's `rankSites` now takes a strategy/order/district; the map re-ranks itself and the lens badge
  names the view.
- Every frame is the real app assembling a real answer; the console beat is a real query. No stock
  footage, no bullet slides — that would be the wall of text the product replaces.
- Music: low, minimal, one bed under everything, ducked under the voice. Accent teal `#6ff0e0` for
  captions; the winner-yellow `#FAFF69` is reserved for the #1 pin.
