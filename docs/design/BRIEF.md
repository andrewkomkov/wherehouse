# Design brief — WhereHouse

> **There is a round 2: [`BRIEF-2.md`](./BRIEF-2.md).** Read this brief first (it still
> stands in full), then round 2 — it covers the dashboard the map now lives inside, the
> historical-momentum chart, and the multi-turn conversation, all of which shipped after
> this was written.

**Read this first.** Then [ADR-001](../architecture/progressive-map.md), which describes
the one interaction everything else serves.

You can start immediately — this brief is not blocked on engineering. What we need back
is listed at the bottom.

---

## Context: what this is and why the deadline is real

**WhereHouse** is our entry to the **ClickHouse × Trigger.dev Virtual Summer Hackathon
2026**. It is a 7-day build: the window opened 17 July and the submission portal closes
**23 July at 12:00 UTC** (00:00 AoE), server-enforced, no extensions. Winners announced
29 July. A jury of 15+ engineers from ClickHouse and Trigger.dev scores every entry.

That shapes everything you'll read below:
- **The audience is engineers**, not consumers. They are judging ~50 other entries in a
  row. Ours has ~10 seconds to look different.
- **Scoring** is: Use of ClickHouse & Trigger.dev 25% · Problem Fit 20% · Technical
  Implementation 20% · **Innovation 20%** · Scalability 10% · **Presentation 5%**.
  Design directly serves the 25% of the score a judge can *see* (innovation +
  presentation), and indirectly all of it — a confusing UI reads as a weak build.
- **Deliverable is a 5-minute demo video**, not a live session. The design has to
  photograph well in motion.

### The stack you're designing against

| Layer | What | Means for you |
|---|---|---|
| **Map** | MapLibre GL 5.x + Protomaps vector tiles (PMTiles) | Full styling control; vector, so we can recolour/filter live at 60fps. Not Mapbox, not Google. |
| **Agent** | Trigger.dev `chat.agent()` | Streams *typed parts*, not just text. A part can be a map layer. Parts with a stable id **update in place** → progressive fill. |
| **Data** | ClickHouse Cloud (primary DB) + Overture Maps POIs | Sub-second queries over millions of points. Layers can arrive fast and be re-queried cheaply. |
| **Routing** | Valhalla | Walk-time isochrone polygons. |
| **Hosting** | The page itself is served **out of ClickHouse** ([ADR-003](../architecture/clickhouse-as-webserver.md)) | Self-contained page: inline CSS, small JS bundle, no exotic font CDN, no heavy asset pipeline. |

The stack is not decoration — the reason the map can fill in progressively is a genuinely
new Trigger.dev capability (`chat.agent()` shipped 2 July 2026). We're designing for
something that mostly couldn't be built a month ago. That's the innovation story.

## The product in one line

Ask *"where should I open a bakery in Berlin?"* — the answer is a map that assembles
itself while the agent thinks. Not a chart at the end. **The map IS the answer.**

## The judging lens — this is our design constraint

The hackathon theme is *"Beyond the Wall of Text"*. Verbatim from the brief:

> Every chat agent gives you the same thing: a wall of text. […] It's a terrible way to
> understand anything. But chat doesn't have to be text. **Judging lens: ratio of insight
> to words. Text is the garnish, not the meal.** If your agent's best answer is a
> paragraph, you've missed the brief.

So: **every pixel of prose is a liability.** If something can be a shape, a colour, a
position, or a motion — it must not be a sentence. Two sentences of text per answer is
the target, and they should read like a caption, not an explanation.

We are scored on *Presentation* (5%) but far more on *Innovation* (20%) — and the
innovation the judge will actually *see* is this interaction.

## Who it's for

- **Investors / municipalities** — siting a kindergarten, clinic, pharmacy
- **Operators** — the next coffee shop, bakery, gym

Tone: a serious analyst's tool, not a consumer toy. These people are spending real money
on a lease. Confidence without cheapness. Think Bloomberg terminal crossed with a good
map, not a chatbot with a map bolted on.

## The core interaction — a map that fills in

One question paints the map in waves. The agent streams each layer as it's computed;
each wave lands **seconds apart**, and the user watches it happen. This is the demo, the
pitch, and the product, all at once.

| # | What lands | Where it comes from | Feels like |
|---|---|---|---|
| 1 | map flies to Berlin | instant | "it understood me" |
| 2 | "pulling 40k POIs…" | progress, transient | "it's working" |
| 3 | competitor bakeries drop in as dots | ClickHouse | "oh, that's the market" |
| 4 | 5/10/15-min walk isochrones bloom outward | Valhalla | "that's my catchment" |
| 5 | H3 hex choropleth fades in | ClickHouse | "that's the opportunity" |
| 6 | top-3 sites pin + rank | agent | "that's the answer" |
| 7 | two sentences | agent | the caption |

Waves 3–5 arrive **in batches**, not all at once — layers *materialize* progressively.
This is technically real, not a fake loading animation: the map part updates in place as
data streams in.

**Design questions this raises — these are yours to answer:**
- How does a layer *arrive*? Fade? Scale-in? Stagger by distance from centre? It must
  read as "computed", not "animated for fun".
- How do 4 overlapping layers stay legible? Dots over hexes over isochrones over basemap.
- What does the map look like at wave 1 vs wave 6 — how do we avoid a mess at the end?
- What does the user do while waiting 3 seconds? (Watching is fine — if it's worth watching.)

## Layout

Chat and map must coexist. The map is the product, so it gets the space — but the chat is
how you steer it. Open question we'd like your take on:

- **Map-dominant with a chat rail** (map full-bleed, chat as an overlay panel) — map wins,
  but the conversation history gets cramped.
- **Split** (chat left ~380px, map right) — conventional, safe, and every other team will
  do this.
- **Something else.** E.g. chat collapses to a single input + the last answer, and history
  is reachable but out of the way. The map is never smaller than it has to be.

Note the answers *are* map layers, so "chat history" is partly a **map state history** —
scrolling back could mean the map rewinds. That might be a great idea or a terrible one.
Your call.

## Colour: the sponsors, and the trap

The jury is ClickHouse and Trigger.dev engineers. Looking native to their world is worth
something. But their palettes carry a genuine trap — read this before picking anything.

### The official values

**ClickHouse** — from their design system, [clickhouse.design/brand/color](https://clickhouse.design/brand/color)
(official, read from their own design tokens):

| | Hex | Token |
|---|---|---|
| Primary yellow | **`#FAFF69`** | `primary.300` |
| Neutral black | **`#151515`** | `neutral.900` |
| Teal accent | `#00FFD4` | |
| Violet accent | `#AA00FF` | |
| Info / Success / Warning / Danger | `#135BE6` / `#2AC656` / `#FF9416` / `#FF2323` | |

Their own guidance, verbatim: *"The yellow is most prominent in our marketing […] where it
should be used as the dominant colour"* but *"In our product, it should be used primarily
as an accent."* Their **product is black-dominant with yellow accents**. Fonts: Söhne
(marketing), Inter (product). Note their logos ship **monochrome**, not yellow.

**Trigger.dev** — no published colour guideline exists; their brand page ships logos only.
These come from their **open-source stylesheet** (first-party, but not a guideline):

| | Hex | Note |
|---|---|---|
| Accent green | **`#A8FF53`** | `--color-primary` in their webapp |
| Signature background | **`#121317`** | `charcoal-900` |
| Surfaces | `#2c3034` / `#272a2e` | secondary / tertiary |
| Link | `#826dff` | lavender |
| Logo gradient | `#41FF54` → `#E7FF52` | **different green from the accent** — flagged, not papered over |

Their stylesheet says outright: *"Defaults below are the original dark theme"* — light is a
scoped override. **Dark-first, explicitly.**

### The trap

**`#FAFF69` and `#A8FF53` are nearly the same colour.** A yellow-green and a green-yellow,
both fully saturated, both screaming for attention. Put them side by side and they read as
a mistake rather than as two brands. Worse: that hue family is exactly where a
"high value" choropleth ramp wants to end — so the sponsors' accents will fight our most
important data layer.

### The recommendation (argue with it)

1. **Go dark.** Both sponsors are dark-first, dark is where data-on-map reads best, and it
   makes bright data pop. This also resolves the light/dark question from earlier.
   `#151515` / `#121317` are almost the same black — pick one and move on.
2. **Do not build the data layers from brand colours.** The choropleth, isochrones and
   category dots need a palette chosen for legibility and colour-blind safety — read the
   `dataviz` skill before choosing. Brand colours are chrome, not data.
3. **Spend the yellow-green in exactly one place, where it means something.** The obvious
   candidate: **the #1 top pick**. `#FAFF69` on the winning pin is a nod to ClickHouse *and*
   the single most important pixel on the screen. Using it for buttons and hovers and
   borders spends it into meaninglessness.
4. **Don't use both accents.** Pick one. Using ClickHouse yellow and Trigger green together
   looks like a sponsor slide, not a product.

This is a recommendation, not a spec. If you have a better idea — especially one that makes
us look like we belong in their ecosystem without cosplaying it — take it.

## The layers you're designing

1. **Basemap** — Protomaps/MapLibre vector tiles. Dark or light is your call; we have
   `light`, `dark`, `white`, `black`, `grayscale` flavours available. Our sibling project
   defaults to dark and it reads well for data-on-top.
2. **Competitors** — point layer, up to a few thousand. Category matters (bakery vs cafe
   vs supermarket). Density is the message.
3. **Isochrones** — 3 nested walk-time polygons (5/10/15 min). Nested bands, outer drawn
   first. Must not bury the dots.
4. **Score choropleth** — H3 hexagons (~0.7 km² each at res 8), continuous 0–1 score.
   This is the "where's good" layer and the emotional centre of the answer.
5. **Top picks** — 3 ranked pins. These are the actual answer. They must win the page.
6. **Saved sites** — the user's own portfolio (a different visual class from picks —
   these are *theirs*).

Colour is load-bearing here: choropleth + isochrones + categorical dots must not fight.
Before choosing a palette, read `dataviz` guidance on sequential vs categorical ramps —
and note the choropleth must stay readable *under* semi-transparent isochrones.

## Animation spec — where motion is expected, and where it is banned

Motion is the product here, so it needs to be deliberate. Below is where we expect it.
Timings are a starting point, not a contract — tune them.

**The rule: every animation must represent something real happening.** A layer fades in
because data *just arrived*. A hex recolours because the score *actually changed*. We are
never animating to look busy. If motion doesn't carry information, cut it.

| # | Moment | Expected motion | Notes |
|---|---|---|---|
| 1 | **Map flies to city** | `flyTo`, ~800–1200ms, ease-out | The only "free" animation. Sets the stage. Must feel decisive, not touristy. |
| 2 | **Agent is working** | Transient status line + subtle pulse | This is the *only* indeterminate spinner allowed. It disappears forever once wave 3 lands. |
| 3 | **Competitor dots arrive** | Stagger-in, batched | They arrive in real batches from the DB. Stagger by index or by distance from centre. ~15–30ms between dots, capped so 2000 dots don't take a minute. Scale 0→1 + fade reads better than fade alone. |
| 4 | **Isochrones bloom** | Outward, 5→10→15 min, ~200ms apart | Must read as *spreading from the point*. Draw outer band first, inner on top. This is the most "wow" moment — it looks like the catchment growing. |
| 5 | **Choropleth fades in** | Per-hex stagger, ~400ms total | Do NOT fade the whole layer as one block. Hexes appearing individually reads as "computed"; a block fade reads as "image loaded". |
| 6 | **Top-3 pins land** | Drop + settle, sequential, ~150ms apart, rank 3→1 | Counting *up* to the winner. The #1 pin is the climax of the entire answer — it can afford one extra beat. |
| 7 | **Text caption** | Type-on or simple fade | It's the garnish. Do not make it the event. |
| 8 | **Slider re-weight** | **Zero latency, zero animation** | Recolour must be *instantaneous* — this is client-side, no round-trip. Any transition here destroys the "it's alive" feeling. The one place motion is banned. |
| 9 | **Hover a hex / dot** | ~80ms highlight | Snappy. Tooltip must not fight the layers underneath. |
| 10 | **Layer toggle** | ~150ms fade | Utility, not spectacle. |

**Banned:** loading skeletons that pretend (our data is genuinely fast — show the real
thing), bouncy/elastic easing (this is an analyst's tool, not a game), anything that
delays the user seeing a real result, parallax, decorative particles.

**The critical sequence to design:** waves 1→6 take roughly **3–6 seconds end to end**.
That's the entire demo. Storyboard it as a motion study before anything else — if it
doesn't work as a 6-second silent clip, the design isn't done.

## Interactive weighting — the "explorable" requirement

The theme demands the answer be **explorable**, not just visual. Our lever: the user
re-weights the factors (footfall vs rent vs competition vs accessibility) with sliders,
and **the choropleth recolours instantly, client-side, with no server round-trip.** This
is proven tech (our sibling project does it with a MapLibre `interpolate` expression).

Design need: sliders that feel like an instrument, not a settings form. The recolour is
instantaneous — that immediacy is the feature. Show it off.

## Provenance — a trust surface, not a footnote

For an agent, *"how do you know that?"* is the whole game. Some numbers are measured
(real walk times from a routing engine), some are estimated (decay proxies where the road
graph doesn't reach). We will know which is which per result.

We want this **visible but not nagging**. A judge asking "is this made up?" should get an
answer from the interface, not from us talking over the demo.

## The 5-minute demo video

The brief says: *skip the intro, open directly on the working product.* Our first shot is
one question, and the map assembling itself. **Design for that shot.** If the first 10
seconds don't make a judge lean in, nothing later saves it.

## Constraints (hard)

- **MapLibre GL 5.x** + Protomaps vector tiles. Not Mapbox, not Google.
- Cities: **Berlin, Amsterdam, Belgrade**. Real OSM/Overture data — real densities, real
  gaps, real messiness. Berlin has 2158 cafes and 1545 bakeries; design for that clutter.
- **The whole page may be served out of ClickHouse itself** (see [ADR-003](../architecture/clickhouse-as-webserver.md)) —
  so: self-contained, no heavy asset pipeline, no exotic font CDNs. Assume inline CSS and
  a small JS bundle.
- Deadline **23 July 12:00 UTC**, server-enforced. Anything not built by ~21 July won't ship.
- Dark/light: pick one and do it properly. Two half-done themes is worse than one good one.

## What we need back, in priority order

1. **The wave choreography** — how layers arrive. This is the product. Even a rough
   motion study or an annotated storyboard beats a static comp.
2. **Layout decision** — chat vs map, with a reason.
3. **Colour system** — basemap + 4 data layers that coexist. Choropleth ramp is the
   centrepiece.
4. **The top-3 picks treatment** — the answer must be unmissable.
5. Sliders, provenance affordance, empty/loading/error states.

Rough and fast beats polished and late. We have five days.
