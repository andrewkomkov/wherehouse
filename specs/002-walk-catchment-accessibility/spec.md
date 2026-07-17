# Feature Specification: The walk catchment, and Accessibility as a real factor

**Feature Branch**: `002-walk-catchment-accessibility`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "Изохроны на экран — данные есть, слоя нет. Бриф называет это «самым wow-моментом», и это же включает честный Accessibility и чип CATCHMENT · MEASURED."

## Overview

The product currently answers *"where should I open a bakery in Berlin?"* with three layers —
competitors, an opportunity surface, three ranked pins. Every one of them is a **count in a
hexagon**. None of them knows that a river, a rail cutting or a motorway makes the cell next
door a twenty-minute walk away.

We have held the fix since 17 July and never shown it: `geo.isochrones` and
`geo.isochrone_cells` hold every pedestrian catchment for all three cities, measured by
Valhalla against the real street network. This feature puts them on screen and lets them
change the answer.

It delivers three things:

1. **The shape.** The real Valhalla contour for a pick, drawn on the map — the first thing in
   this product that follows streets rather than tiling the world into hexagons.
2. **The chip.** `CATCHMENT · MEASURED`, which the client cuts today on purpose because the
   claim would have been false.
3. **The factor.** *Accessibility* — residents who can genuinely walk to a cell in 10 minutes
   — as a third re-weightable term in the score, alongside Residents and Low competition.

**The hard part is not any of those three.** It is that a third of Berlin has no measured
catchment, and the score is multiplicative, so every possible fill-in value is a lie. This
spec is written mostly about that.

## Verified measurements *(constitution II — executed, not read from docs)*

All measured against the live ClickHouse service (26.4.1.2029) on **2026-07-17**. The
accessibility query is the one this feature ships; the coverage numbers are its output, not a
projection.

### The tables exist and are loaded — all three cities

| table | berlin | amsterdam | belgrade | total |
|---|---|---|---|---|
| `geo.isochrone_cells` rows | 382,087 | 120,784 | 132,209 | **635,080** |
| `geo.isochrones` contours | 30,393 | 14,189 | 18,897 | **63,479** |
| distinct origins (res 9) | 9,977 | 4,595 | 6,152 | **20,724** |

### The accessibility query — 467 ms, Berlin, end to end

Origin is the cell's **centre child at res 9** (`h3ToCenterChild(h3_8, 9)`); reach is
`geo.isochrone_cells` at `minutes = 10`; demand is `geo.population` joined on
`h3ToParent(reachable_h3_9, 8)`, summed as `population / 7`.

| city | populated cells | measured | % cells | **% of population** | acc p95 | median | max |
|---|---|---|---|---|---|---|---|
| berlin | 2,260 | 1,430 | **63.3** | **92.7** | 11,326 | 3,886 | 17,890 |
| amsterdam | 739 | 649 | **87.8** | **97.0** | 10,762 | 962 | 14,923 |
| belgrade | 1,076 | 894 | **83.1** | **97.5** | 8,161 | 557 | 23,979 |

**Berlin is the worst of the three, and that is a fact about its bbox, not about Valhalla.**
The Berlin box reaches into rural Brandenburg (the same reason `geo.districts` only resolves
`area` for 56.8% of its cells — see 001). Specifying this feature against Berlin alone would
have shipped "31% is unmeasured" as a universal claim; it is 12.2% in Amsterdam.

**The number that matters is the population column, not the cell column.** The unmeasured
cells are the empty ones: 92.7–97.5% of every city's residents live in a cell we did measure.

### Physical sanity — checked against our own data, not against recollection

A 10-minute walk is ~800 m, so a catchment is ~2 km². The accessibility maxima must therefore
imply a plausible density, and they do — but the check only means something if the density it
is compared against is *measured*, so it is taken from `geo.population` itself (a res-8 cell is
0.737 km²):

| | berlin | belgrade |
|---|---|---|
| densest populated cell (Kontur) | 8,693 people | **14,965** |
| ⇒ peak density | 11,795 /km² | **20,305 /km²** |
| p99.9 cell | 7,954 | 12,680 |
| max measured accessibility (this feature) | 17,890 | **23,979** |
| ⇒ implied mean density over the ~2 km² catchment | 8,945 /km² | 11,990 /km² |

Both maxima sit **below** their city's peak cell density, which is the direction that makes
sense: a 2 km² catchment averages over more than the single hottest hex.

**Belgrade's accessibility max exceeds Berlin's, and that is correct rather than suspicious** —
central Belgrade is genuinely denser than central Berlin, by our own Kontur data (20,305 /km²
against 11,795). That sentence was written from recollection first and checked second; the
check is the only reason it is still here.

### The invariant that discriminates — verified, zero exceptions

Across all 1,430 measured Berlin cells:

| check | result |
|---|---|
| cells whose contour does **not** reach their own res-8 parent | **0** |
| cells where `acc_pop < own_pop / 7` | **0** |
| true `min(acc_pop)` | **0.286** (the `0` first seen was `round()`, not a bug) |
| `min(reachable_cells)` | 1 — a real dead-end origin, not an error |

A cell must be able to reach itself on foot. It does, everywhere. This is the check to keep:
it is cheap, and it would fail loudly if the origin→reach join were ever wired backwards —
the failure mode this project has been bitten by three times (`geoToH3`, `h3ToGeo` and
`h3PolygonToCells` are not all ordered the same way).

### The picks — the demo path is covered

All three of Berlin's real top-3 bakery cells (`881f18b645fffff`, `881f1d4d81fffff`,
`881f18b021fffff`, all at gap 100.0) have isochrones on **all 7** of their res-9 children.
The wow shot is not at risk from coverage.

## What "not measured" means — and what it must never be allowed to mean

This section is the spec. Everything else follows from it.

`infra/valhalla.sh` runs with `search_cutoff: 150`, chosen from geometry (a res-9 cell is
~180 m across). When Valhalla returns 4xx for an origin it is saying, precisely:

> there is no walkable edge within 150 m of **this one point**.

The loader treats that as a legitimate skip — correctly, and that setting is the fix for the
day-4 bug where a 35 km default cutoff silently snapped origins to roads kilometres away and
stored *that road's* catchment under our cell id.

**It does not license the inference "nobody can walk here."** A res-8 cell is 0.74 km²; its
centre child is a single sample point. A lane in the corner of that cell is entirely
consistent with the observation. The 830 unmeasured Berlin cells average **375 residents**
against **2,752** in the measured ones — sparse, which is why they are unmeasured, but not
empty, and "sparse" is not "unwalkable".

*(That 375 was written as 346 in the first draft of this spec — the figure for a different
sample, the 704 cells with no covered child at all, carried across to the 830-cell centre-child
set because both were "the uncovered ones". Constitution II's first rule, caught by re-running
the query instead of trusting the sentence: a number is not evidence for the words next to it.)*

So the honest label is **not measured**, and:

- **An unmeasured cell MUST NOT receive an invented accessibility value.** The score is a
  product (`gap = Π terms`). A fill-in of 0 says "nobody can reach this" — false, and it
  zeroes the cell. A fill-in of the p95 says "excellently connected" — false, and it may
  float a cell into the top 3. There is no neutral number, because a factor in a product has
  no value that is both neutral and honest.
- **It MUST be visible.** A cell that silently drops out of a ranking is indistinguishable
  from a cell that scored badly.

This is a judge-facing feature, not an apology: showing where the data stops is the one thing
in this product a competitor's demo will not do.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The catchment, drawn (Priority: P1)

Someone asks where to open a bakery in Berlin. As the agent finishes ranking, a shape settles
around the winning pin that is unmistakably **not a circle and not a hexagon**: it follows
streets, stops at the rail line, and reaches down the high road. The caption may now say the
word *walk*, and the chip under it says `CATCHMENT · MEASURED`.

**Why this priority**: The brief calls this the single biggest wow moment, and it is the only
layer in the product whose geometry came from routing rather than from tiling. It is also
independently shippable — it needs no change to the score.

**Independent Test**: Ask the primary demo question. A contour renders around pick #1, its
vertices follow the street network, and the wave row "Walk catchment · Valhalla" reaches ●.

**Acceptance Scenarios**:

1. **Given** the Berlin bakery question, **When** `rankSites` completes, **Then** a walk
   catchment polygon is on the map around pick #1 and the `CATCHMENT · MEASURED` chip is shown.
2. **Given** the catchment layer is on screen, **When** the user toggles "Walk catchment" off,
   **Then** the contour disappears and the other layers are untouched.
3. **Given** a pick whose cell has no measured catchment, **When** the layer would be emitted,
   **Then** no contour is drawn, the chip does **not** appear, and no placeholder shape is
   substituted.

---

### User Story 2 - Accessibility as a factor you can pull (Priority: P2)

The user drags the **Accessibility** slider up. The surface recolours instantly, and cells
that looked good on residents alone but sit behind a rail cutting fall away, while cells on a
connected high street rise. At the same moment the map states, visibly, that 830 of Berlin's
cells were never measured — they render as "not measured" and take no part in the ranking.

**Why this priority**: It converts the isochrones from a picture into a claim that changes the
answer, and it is the honest completion of the comp's re-weight rail. It depends on nothing in
US1, but it is worth less on its own — the shape is what a judge remembers.

**Independent Test**: Move Accessibility off neutral and confirm the surface recolours with no
round-trip, the not-measured count appears, and returning to neutral restores exactly the
agent's own ranking.

**Acceptance Scenarios**:

1. **Given** neutral weights, **When** the surface renders, **Then** every cell's colour equals
   the score ClickHouse itself computed for that cell — and the "not measured" state IS visible,
   because neutral weights accessibility above zero.
2. **Given** Accessibility above zero, **When** the surface recolours, **Then** unmeasured
   cells render in the "not measured" style, are excluded from the ranking, and the rail shows
   their count.
3. **Given** Accessibility dragged to zero, **When** the surface recolours, **Then** the
   unmeasured cells rejoin the surface and score on the remaining two factors, and the
   "not measured" styling and count disappear.
4. **Given** any weight combination, **When** the score is recomputed, **Then** the SQL, the JS
   and the MapLibre expression agree to the last digit (`pnpm verify:score`, 0 mismatches).

---

### User Story 3 - The agent may finally say "walk" (Priority: P3)

The caption says *"…within a 10-minute walk"* — and it is true, because a tool measured it.
It still refuses to describe the competitor count that way, because that is an H3 ring and
always was.

**Why this priority**: Cheap, and it retires a standing prompt ban that currently costs the
demo its best sentence. But a wrong turn here re-opens the worst bug this project has had, so
it ships behind the data, never ahead of it.

**Independent Test**: Run the primary question live and diff every walk-claim in the prose
against the tool payloads.

**Acceptance Scenarios**:

1. **Given** a pick with a measured catchment, **When** the agent writes its caption, **Then**
   it may describe reachability as a walk, sourced from the tool's value.
2. **Given** the competitor count (`sup`), **When** the agent describes it, **Then** it never
   calls it a walk, a catchment, a walking distance or a travel time.
3. **Given** a pick with no measured catchment, **When** the agent writes its caption, **Then**
   it makes no walk claim about that pick at all.

---

### Edge Cases

- **A pick has no measured catchment.** No contour, no chip, no substitute. The pin, its score
  and its district name are unaffected. (Not on the demo path — all three Berlin picks are
  covered — but it is a contract the code owes, and the day it fires must not be the day we
  discover the model improvises.)
- **A contour is a MultiPolygon.** `geo.isochrones` stores one row per lobe on purpose —
  verified 17 Jul: **445 of Berlin's contours are multi-lobed**, contributing 462 extra rows to
  its 30,393. Dropping "minor" lobes is how a catchment ends up drawn 2 km from the cell it is
  labelled with. Every lobe renders.
- **All sliders at zero.** Already defined as neutral (`score.ts`), and must stay neutral with
  three factors rather than becoming a divide-by-zero or an arbitrary winner.
- **Accessibility above zero in a city where coverage is high.** Amsterdam drops 90 cells, not
  830. The count is per-answer and measured, never a constant.
- **A cell measured as reaching almost nobody.** `acc_pop` of 0.286 is a real measurement and
  must score as such — it is distinct from *not measured* and must not be styled as it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST render the real Valhalla contour for a ranked pick as a map
  layer, drawn from the stored geometry and never from a radius, a buffer or a hex union.
- **FR-002**: The catchment layer MUST render every lobe of a multi-lobed contour.
- **FR-003**: The `CATCHMENT · MEASURED` chip MUST appear if and only if a real measured
  contour is on screen.
- **FR-004**: The assembly rail MUST show a "Walk catchment · Valhalla" wave whose state is
  derived from the real layer landing, never from a timer.
- **FR-005**: The catchment layer MUST be independently toggleable without affecting other
  layers.
- **FR-006**: Accessibility MUST be a third re-weightable factor, defined as *residents within
  a 10-minute walk*, measured from the cell's res-9 centre child.
- **FR-007**: At neutral weights the surface MUST equal the score ClickHouse itself computed —
  the three-factor product. It is **not** required to match today's two-factor map, and it will
  not: adding a real factor changes the answer, which is the point of adding it.
- **FR-008**: A cell with no measured catchment MUST NOT be assigned an accessibility value by
  any means — no default, no interpolation, no neighbour fill.
- **FR-009**: When the Accessibility weight is above zero — which includes **neutral** — cells
  with no measured catchment MUST render in a distinct "not measured" style and MUST be excluded
  from the ranking.
- **FR-009a**: The "not measured" style MUST inherit the ramp's opacity discipline: its
  prominence is driven by the cell's score on the remaining factors, so that a cell which would
  have been invisible stays invisible and a cell which would have been prominent announces
  itself. Flat-filling every unmeasured cell is a defect (735 of Berlin's 830 are near-invisible
  today; only 6 score ≥ 40).
- **FR-009b**: When the Accessibility weight is zero, unmeasured cells MUST rejoin the surface
  and score on the remaining factors, and the "not measured" style and count MUST disappear.
  This MUST fall out of the weighting maths (exponent 0 ⇒ the factor drops out), not from a
  special case.
- **FR-010**: The count of unmeasured cells MUST be surfaced to the user, measured per answer
  and per city, never hardcoded.
- **FR-011**: The scaling scalar for accessibility MUST be derived server-side per city and
  category (as `popP95`/`supP95` already are) and shipped to the browser — never recomputed
  client-side, which would produce a different p95 and silently drift the map off the ranking.
- **FR-012**: The three encodings of the score (SQL, JS, MapLibre expression) MUST agree, and
  `pnpm verify:score` MUST report zero mismatches across all three cities.
- **FR-013**: The agent MAY describe reachability as a walk **only** where a tool returned a
  measured catchment value, and MUST NOT describe the H3-ring competitor count as a walk, a
  catchment, a walking distance or a travel time.
- **FR-014**: Scoring MUST preserve the verified invariant that a measured cell reaches its own
  res-8 parent; a violation is a wiring error and MUST fail a check rather than ship.

### Key Entities

- **Walk catchment (contour)**: the drawn pedestrian isochrone for one origin and one time
  band. One row per lobe. Rendered, never joined.
- **Reachable cell**: a fact — (origin, minutes, reachable cell). Joined, never drawn.
- **Accessibility**: residents reachable on foot in 10 minutes from a cell's centre child.
  Measured, per cell, or **absent** — absent is a first-class state, not a zero.
- **Not-measured cell**: a populated cell whose centre child has no walkable edge within 150 m.
  Carries a population and a score on the other two factors; carries no accessibility.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Asking the primary demo question puts a street-following catchment on the map
  without the user asking for it.
- **SC-002**: A viewer can tell, without being told, which parts of the city the product has
  not measured — the not-measured state is legible on sight.
- **SC-003**: Moving a weight slider recolours the surface with no perceptible delay and no
  network round-trip.
- **SC-004**: Returning every slider to neutral reproduces the agent's own top-3 exactly.
- **SC-007**: Adding the factor changes the agent's answer in a way that survives scrutiny —
  the displaced pick must be displaced *for a reason a human can check on the map*, not by a
  rounding artefact. (Measured: Berlin's #3 moves from a detached-house suburb whose residents
  a 10-minute walk cannot reach, to the densest cell in the city.)
- **SC-005**: Every walk claim in the agent's prose traces to a tool-returned measurement; a
  claim that does not is a regression.
- **SC-006**: At least 92% of every demo city's residents live in a cell with a measured
  catchment, and the figure is re-measurable on demand rather than asserted.

## Assumptions

- **Population is uniform within a res-8 cell.** Reach is res-9 and Kontur is res-8, so a
  reachable res-9 cell contributes `population / 7`. This is an approximation, it is the same
  granularity the product already ranks on, and it is stated rather than hidden. It cannot be
  removed without a finer demand source.
- **The centre child represents the cell.** One sample point per 0.74 km². Chosen over
  "any covered child" (which reaches 68.8% of Berlin cells against 63.3%) because "the
  catchment from the centre of the cell" is a claim that can be explained in one sentence and
  falsified in one query; "the catchment from whichever corner happened to route" is neither.
  The cost is 5.5pp of cells — 1.6pp of population.
- **10 minutes is the band.** 5 and 15 are also stored; 10 is the one the score uses and the
  one the contour draws. Exposing the other two is out of scope.
- **The isochrone data is a build-time artifact and will not be recomputed for this feature.**
  It is loaded, verified-or-rolled-back, and current.
- **`chat.agent()` in-place part updates, the 1 MiB cap and the handle path all behave as
  already proven** (ADR-001, day 2/3). The catchment layer is small and is expected inline;
  `emitLayer` decides on measured bytes, so nothing here needs to care.

## What this cuts *(constitution VI)*

- **The 5- and 15-minute bands on screen.** Stored, not exposed. A time-band selector is a
  second control on a rail that already has enough, and it moves no criterion.
- **Click-anywhere catchment.** The data supports it (24.6 ms lookup, res-9 snap) and it is a
  good demo — but it is a new interaction, and the catchment around the *pick* is the shot the
  brief actually calls for. Revisit only if US1 and US2 land early.
- **Isochrones for the competitor layer** ("which shops can this cell's residents reach?").
  Real, interesting, and a different question than the one this product answers.
- **Re-running Valhalla to raise coverage.** Lowering `search_cutoff` below 150 m is the bug
  we already fixed; raising it fabricates catchments. The coverage is what it is, and saying
  so is the feature.
