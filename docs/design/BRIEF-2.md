# Design brief — round 2 — WhereHouse

**Read [`BRIEF.md`](./BRIEF.md) first.** That brief still stands: dark-first, map-is-the-answer,
insight-to-words, the 7-wave choreography, the colour trap, `#FAFF69` spent only on the #1 pick.
Nothing here revokes it. This is an **addendum**: since round 1, five features shipped and the
product grew a dashboard around the map. Round 1 asked you to design a map that fills in. Round 2
asks you to design the **instrument the map now lives inside** — and to make a multi-question
*conversation* read as well as the single answer already does.

The engineering is done and browser-verified; this is not blocked on us. What we need back is at
the bottom.

---

## What changed since round 1

The map that assembles itself is real and working. Around it, five signals now exist. Every one is
computed from ClickHouse (and, for momentum, OSM history) — none is decoration, and each has an
*honesty rule* the design must respect, because a jury of engineers will probe exactly the numbers
that look too clean.

| Signal | What it is | The honesty rule the design must not break |
|---|---|---|
| **Walk catchment** (F1) | A real street-following 10-min isochrone around the #1 pick; feeds a 3rd slider, **Accessibility** | Only shown when Valhalla actually measured it. ~38% of cells are *not measured* — that "not measured" state is a feature to show, not hide. |
| **Saved sites** (F2) | The user's own portfolio of sites, each re-scored against *today's* market (OLTP Postgres → CDC → ClickHouse) | A saved site's market gap may be **absent** (unscored) — never render absent as `0`. Their sites are a different visual class from the agent's picks: *theirs*, not *ours*. |
| **Momentum** (F3) | A monthly time series per category over ~4 years; direction is **rising / flat / saturating** | It is **relative momentum from OSM edit history**, never an absolute count, never "live". Say the window truthfully ("since 2022"). When history is too thin: **"trend unknown"**, never a fake flat line at zero. |
| **Dashboard** (F4) | A compact "Market at a glance" stat strip that frames the map | 3–4 tiles maximum. A tile is **absent until its layer lands** (absent ≠ 0). Values wear text ink; the accent is reserved for chrome and the #1 pick. |
| **Affinity** (F5) | A per-cell neighbourhood-fit score — a barbershop next to a cafe is a plus | It is a **hand-authored editorial heuristic**, not a measurement. It must be *labelled* "editorial affinity" wherever it appears. Never dressed as data. |

The through-line: **measured, estimated, and editorial are three different truth-classes**, and the
design's job is to make which-is-which legible at a glance without a paragraph of caveats. Round 1
already introduced this as "provenance". Round 2 is where it has real teeth, because now there are
signals in all three classes on screen at once.

---

## The look right now, and the two words for what's wrong

Here is the built product today (annotated screenshot attached separately). It works, and the map is
genuinely the hero — but the owner's reaction was two words: **it doesn't look agentic, and it
doesn't look like a dashboard.** Both are fair, and they're the brief.

**What's on screen now:** one tall, ~500px-wide rail floating over a full-bleed map, stacking — top
to bottom — the question box, four "at a glance" tiles, the caption, a momentum sparkline, an
ASSEMBLY list (the 7 waves, each labelled agent / ClickHouse / Valhalla), a LAYERS legend with
toggles, four RE-WEIGHT sliders, and the TOP PICKS. It is *complete*. It reads as a **cramped
vertical sidebar**, not an instrument.

**"More dashboard" means:** the pieces read as **one composed instrument**, not a single column of
stacked cards. A dashboard has *regions* with a spatial logic — the map is the centre, the KPIs frame
it, the controls are grouped as controls, the answer (top picks) has its own zone. Right now
everything is one scroll. The map should feel *set into* a frame, not *covered by* a panel.
Bloomberg-terminal composure: dense, gridded, calm — not a to-do list.

**"More agentic" means:** you should be able to *feel the agent thinking and working*. Today the
agent's actual reasoning — the ASSEMBLY trace, which is the single most trigger.dev-native thing on
screen (a live tool-call timeline: read question → query ClickHouse → route with Valhalla → rank) —
is a quiet grey list near the bottom. **That trace is the innovation story** (`chat.agent()` streams
typed parts that fill in live). It should be a **first-class, alive** surface: steps lighting up as
they run, each naming its engine, the map reacting in lockstep. The judge should watch the agent
*work*, not read a log of what it did.

Neither of these shrinks the map. The map stays the primary feature. The frame gets composed and the
agent's work gets promoted — around it.

## The three things we need designed

**Every decision here is made from the hackathon's scoring, not from taste.** The rubric (round 1,
verbatim): Use of ClickHouse & Trigger.dev **25%** · Problem Fit **20%** · Technical Implementation
**20%** · Innovation **20%** · Scalability **10%** · Presentation **5%**. When two designs compete,
the one that moves a heavier criterion wins. Each deliverable below names the criterion it serves —
if a choice serves none of them, cut it. That is the whole test.

### 1 — The dashboard: the map lives *inside* it, not beside it
*Serves: Presentation (5%) directly — but it is ~100% of what the judge sees in the first 10s — plus
Problem Fit (20%): a legible instrument reads as a real siting tool, not a demo.*

Right now the stat strip ("Competitors · Top score · Median opportunity · Momentum") and the map
coexist but were built separately — the map is full-bleed and the rail floats over it. We want the
next step: a **dashboard the map is a first-class panel of**, not a chrome bar bolted onto a map.

The constraint from round 1 is unchanged and load-bearing: **the map is still the hero.** This is
not a BI screen with a small map in the corner. It is a map with an instrument frame that makes it
more legible. Bloomberg-terminal-meets-a-good-map, not a chart grid.

Design questions that are yours:
- **How does the map sit inside the frame** so it still reads as the answer, not a widget? Full-bleed
  with a floating instrument rail (today's shape) is one answer — is there a better one where the
  tiles, the map, and the top-picks table read as *one dashboard*?
- **The tiles fill in as the assembly runs** (each absent until its layer lands). That progressive
  fill is the same "it's computing" story as the map waves — should the tiles animate in on the same
  beat as their layer, so the frame and the map breathe together? (Motion rule from round 1 holds:
  every animation represents something real arriving. No busy-motion.)
- **Read the `dataviz` skill before styling any tile.** Stat tiles, the number + unit + label
  hierarchy, and the sparkline (below) all fall under it. Light and dark both, colour-blind-safe.
- Max 3–4 tiles. A number earns a tile only if it changes a decision. Two sentences of caption stays
  the ceiling.

### 2 — Momentum: a small history chart that tells the truth
*Serves: Innovation (20%) and Scalability (10%) — trend the static score can't see, over millions of
ClickHouse rows — and Problem Fit: "rising or saturating?" is a real siting question.*

Momentum is a monthly series over ~4 years with a direction (rising / flat / saturating) and a
percent change. Today it renders as a sparkline + a direction word + a signed percent.

- **Design the sparkline as an instrument, not an ornament.** It answers one question — "is this
  market getting more crowded or opening up?" — and the shape should say it before the number does.
- **The three states must look different at a glance**: rising, flat/saturating, and **unknown**
  (too little history). Unknown is not "flat" — it's the honest empty state, and it needs its own
  treatment that reads as "we don't know", not "it's zero".
- **The honesty label is part of the design.** "since 2022", "relative momentum", "editorial vs
  measured" — these are trust surfaces (round 1's provenance idea), not fine print to bury. A judge
  asking "is this made up?" should get the answer from the chart, not from us narrating.
- It appears **after** the map answer, as one more tile / caption beat — never competing with the
  map for the first 10 seconds of the demo.

### 3 — Conversation: not a chat thread — a timeline of agent *runs*
*Serves: Use of ClickHouse & Trigger.dev (25%, the heaviest) and Innovation (20%) — the run-stack IS
`chat.agent()` made visible; steering + resume are Trigger.dev capabilities no chatbot shows off.*

The agent genuinely holds a multi-turn conversation — the backend keeps the full message history and
the model sees every prior turn, so "what about pharmacies instead?" or "why that one?" work. **But
the UI reads as single-shot**: one input, one latest caption, no visible thread. A user cannot tell a
second question is even possible. (We just shipped the smallest fix — the box clears after you ask —
but that only unblocks the real design.)

**Do not design a chat thread.** A left column of grey/teal message bubbles is what every other team
will build, and it buries the one thing that is ours. The owner's ask is explicit: make this
**super-cool with `chat.agent()`**, the exact Trigger.dev primitive the hackathon is about. So the
conversation model is the *innovation* deliverable, not a layout chore.

**The reframe: a turn is an agent *run*, not a message.** Each question kicks off a run that streams a
live tool-trace (read question → ClickHouse → Valhalla → rank → caption) and paints the map. So the
history is a **stack of runs**, each collapsible to its headline (the question + the map-state it
produced), each expandable to replay its trace. This is the ASSEMBLY panel from the look section above,
promoted to *the* organising metaphor of the whole left side.

Design it with these Trigger.dev-native facts as the raw material — each is a real capability, not a
wish:
- **Typed parts update in place.** A follow-up *steers the same map*; it doesn't post a new bubble
  below. "Now weight accessibility higher" or "show pharmacies too" mutates the live surface. The
  conversation is written *onto the map*, and the run-stack is the index of how it got there.
- **The answers ARE map states**, so history is **map-state history**. Selecting a past run rewinds
  the map to what it showed then — a scrubber over the runs, the map as the playhead. Round 1 called
  this "maybe great, maybe terrible, your call." Make the call; we think it's great and it demos.
- **Runs are steerable mid-flight.** `chat.agent()` accepts steering while a run is still streaming —
  the user can nudge the agent *before it finishes* ("skip the isochrone, just rank"). Design the
  affordance for interrupting/redirecting a run in progress. Nobody's chatbot does this.
- **Runs are durable and resumable.** Sessions survive reload/disconnect (SDK v4.5.0). The run-stack
  is real persistent state, not scrollback — reopening the page resumes the conversation and its map.
  Design what a *returning* user sees.
- **Turn types drive what the map does**, and the run-stack makes them legible: full rebuild (new
  city/category), incremental steer (re-weight / add a layer — map persists and mutates), and
  pure-talk ("why #1?" — **map must not clear**; today it wrongly would). The run's trace should show
  which kind it was.
- **Map-dominant, always.** The run-stack is a narrow, calm index on the left — never a column that
  eats the map. Collapsed by default to headlines; the map is what fills the screen.

---

## What did not change (so you don't re-solve it)

- **Palette, dark-first, the `#FAFF69`-only-on-#1-pick rule** — all still hold. New tiles and the
  sparkline take data colours from the `dataviz` palette, never brand accents.
- **The 7-wave choreography** — unchanged. The catchment (F1) is wave 6.5 in that sequence
  ("Walk catchment · Valhalla"); it's already slotted.
- **Insight-to-words, two-sentence caption ceiling** — the dashboard must not become the wall of text
  we're being judged against. Every tile is one number that changes a decision, or it's cut.
- **Self-contained page** (served out of ClickHouse, ADR-003): inline CSS, small bundle, no exotic
  font CDN. Sparkline and tiles must render without a charting library dependency we can't inline.

## What we need back, in priority order

1. **The conversation model** — how a multi-turn dialogue looks when answers are map states, and what
   the map does across turn types (rebuild / incremental / pure-talk). This is the biggest gap.
2. **The dashboard composition** — map as a first-class panel inside an instrument frame, tiles and
   top-picks reading as one thing, still map-dominant.
3. **The momentum chart** — sparkline + three honest states (rising / flat / unknown) + the
   provenance label, per `dataviz`.
4. Tile system: the number/unit/label hierarchy, absent-not-zero states, light+dark.

Rough and fast still beats polished and late. Reference the working product, not a comp — the map,
the stat strip, the sliders and the top-picks table already exist to design *against*.
