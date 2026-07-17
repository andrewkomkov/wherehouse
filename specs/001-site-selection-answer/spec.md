# Feature Specification: The site-selection answer flow

**Feature Branch**: `001-site-selection-answer`

**Created**: 2026-07-19

**Status**: Draft

**Input**: User description: "Флоу реального ответа: «где открыть пекарню в Берлине?» возвращает живую защитимую карту — конкуренты, хороплет возможностей по H3, топ-3 точки, собирающиеся прогрессивно по мере работы агента. Входные ограничения, а не открытия: лимит ~1 MiB на запись в чат-стриме, поэтому любой слой шире одной категории отдаёт хэндл, а GeoJSON браузер тянет прямо из ClickHouse (ADR-003 доказал, что Cloud отдаёт HTTP с открытым CORS); H3 res 8 для скоринга; формула GAP demand × (100 − supply) / 100; модель видит только { rowCount } (ADR-001, доказан). Данные: geo.places — 211 818 POI по Берлину/Амстердаму/Белграду, h3_8 и h3_9 в MATERIALIZED-колонках; oltp.pg_saved_sites через CDC. showSavedSites в web/src/trigger/chat.ts — расходный каркас."

## Overview

A prospective business owner asks one question in plain language — *"where should I open a
bakery in Berlin?"* — and gets an **answer they can see and argue with**: competitors on the
map, an opportunity surface across the whole city, and three ranked recommendations, each
layer appearing as the agent works it out.

The answer must be defensible to a sceptic. "Defensible" here has a specific meaning, and it
is the bar this spec is written against: **every number on the map traces to real data, and
no constant in the score was invented to make the demo look good.**

This is the feature the product is judged on. It is not a visualisation of a precomputed
answer — the map *is* the reasoning, rendered as it happens.

## Verified measurements *(constitution II — executed, not read from docs)*

Every design decision below rests on these. All measured against the live service on
2026-07-19 unless a different date is given.

### Supply distribution — Berlin bakeries, `h3kRing(h3_8, 1)`, over the 2,260 populated cells

| | median | p75 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| Bakeries visible from a cell (k=1 ring) | 1 | 4 | 12 | 24 | 48 | **64** |
| People in a cell (Kontur) | 1,016 | — | — | ~5,000 | 6,965 | 8,693 |

Berlin bbox holds **2,260 populated cells / 4.25M people**; 1,354 of them see at least one
bakery within the ring. Cell-local (no ring) supply is far thinner: only **514** cells
contain a bakery at all, median 2, max 20.

**This kills the inherited saturation constant.** "3 bakeries = saturated" sits at the
**p75** of ring supply while the real distribution runs to 64. Capping there would flatten
every cell from the 75th percentile upward into a single "fully saturated" bucket — the
supply term would become a constant across a third of the city and the score would degenerate
into "wherever the most people live". The constant is not merely unjustified; it is
**empirically wrong**, and it must not reach the jury. See FR-007.

### Payload sizes — the 1 MiB cap is already exceeded (measured 2026-07-18, ADR-001)

| Layer | Features | GeoJSON | Verdict |
|---|---|---|---|
| Berlin bakery dots | 1,460 | 153 KiB | fits |
| Berlin food & drink dots | 12,746 | **1.27 MiB** | **fails** |
| Every Berlin POI | 139,807 | **14.9 MiB** | **fails** |
| H3 res-8 choropleth | 2,015 cells | ~500 KiB | fits, no margin |
| H3 res-9 choropleth | 9,035 cells | **~2.2 MiB** | **fails** |

Per-feature cost is stable at **~105 B/point** and **~255 B/hex** across both measurements,
so the cap lands at roughly 10,000 points or 4,100 hexes. The choropleth — a layer on the
**happy path of the primary demo** — sits at ~500 KiB with no headroom.

### New trap found while writing this spec — `h3ToGeo` is lat-first

```
SELECT h3ToGeo(stringToH3('881f1d4881fffff'))  →  (52.52358882193954, 13.373676274802081)
```

`h3ToGeo` returns **(lat, lon)**, like `geoToH3` takes (lat, lon) — the whole H3 family is
lat-first while every other ClickHouse geo function is lon-first. This bit the first draft of
the scoring query during this spec: a bbox filter with the tuple elements swapped returns
**zero rows silently** — no error, no warning, just an empty map. Recorded here and in
`CLAUDE.md` because it is the same silent-failure class as the lat/lon bug we already shipped
once.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The opportunity map (Priority: P1)

Someone considering opening a bakery in Berlin asks where to do it. They watch the map
answer: the city appears, competitor bakeries drop in as dots, an opportunity surface washes
across the city in colour, and three ranked pins land on the best cells. They can see *why*
the winners won — they are the coloured cells with no dots near them.

**Why this priority**: This is the product. It is the exit gate for day 3, the first shot of
the demo video, and the only story that carries the *"Beyond the Wall of Text"* theme. If
only this ships, the hackathon submission stands.

**Independent Test**: Ask "where should I open a bakery in Berlin?" in the chat and observe
three layers arrive on one map, each driven by a real ClickHouse query, with no run failure.

**Acceptance Scenarios**:

1. **Given** a fresh chat, **When** the user asks where to open a bakery in Berlin, **Then**
   competitor dots, an opportunity choropleth and exactly three ranked pins appear on a single
   map, and the accompanying text is at most two sentences.
2. **Given** the answer has finished, **When** the user inspects any of the three
   recommendations, **Then** each shows the population and the competitor count that produced
   its score, so the ranking can be checked by hand.
3. **Given** the layers are still arriving, **When** the user watches, **Then** each layer
   appears as its work completes rather than all at once at the end.
4. ~~**Given** the answer has finished, **When** the user reloads the page, **Then** the map
   is still there.~~ **CUT 19 July — see Out of Scope.** Verified false on the first live run
   and descoped rather than left as a claim.

---

### User Story 2 - A question wide enough to break the stream (Priority: P2)

The obvious follow-up — *"show me every restaurant"* — asks for a layer far larger than the
chat stream can carry. The user gets their map anyway. They cannot tell that anything unusual
happened, and neither can the jury.

**Why this priority**: This is the known failure mode that kills the demo live. It is
guaranteed to be asked, by a judge if not by us. Today it is a hard crash. It is P2 only
because P1 must exist first, and P1's own choropleth already exercises the fix.

**Independent Test**: Ask for a layer measured above the cap (Berlin food & drink, 1.27 MiB)
and confirm the map renders completely with no run failure.

**Acceptance Scenarios**:

1. **Given** a layer whose payload exceeds the stream budget, **When** the agent emits it,
   **Then** the map renders every feature and the run completes normally.
2. **Given** any layer at all, **When** the agent emits it, **Then** the run never fails with
   an oversized-record error, whatever the user asked for.
3. **Given** a layer served out of band, **When** it is fetched, **Then** the data comes
   straight from the primary database with no application server in the path.

---

### User Story 3 - Another city, another trade (Priority: P3)

The same question for a pharmacy in Amsterdam, or a kindergarten in Belgrade, answers the
same way.

**Why this priority**: Proves the answer is a system rather than a hardcoded Berlin demo —
which is the difference between "Scalability & Impact" scoring and not. Data for all three
cities is already loaded, so the cost is parameterisation, not ingest.

**Independent Test**: Ask the same question shape for a different city and category; confirm
the layers are computed for that city and category.

**Acceptance Scenarios**:

1. **Given** a question naming any of the three demo cities and a category present in the
   data, **When** the agent answers, **Then** the layers cover that city and that category.
2. **Given** a question naming a city we hold no data for, **When** the agent answers,
   **Then** the user is told plainly which cities are available rather than shown an empty or
   misleading map.

### Edge Cases

- **A category with almost no competitors** (e.g. a trade with 3 sites citywide): the supply
  term is near zero everywhere and the score collapses to population. The answer is still
  correct but says little — the map must not imply false precision.
- **A category absent from the data**: answer honestly that we do not hold it. Never render
  an empty map that reads as "nowhere is good".
- **Ties at the top of the ranking.** The demand term clamps at its scaling percentile, so
  several cells legitimately reach the same top score (measured: three cells tie at exactly
  100.0). Ranking MUST be deterministic — the same question must not produce a different top-3
  on a re-run.
- **A populated cell with no competitors anywhere near it** scores maximally, which may mean
  "opportunity" or may mean "a park, a cemetery, or an airport". Day 3 does not model land
  use; the spec states this as a known limit rather than pretending otherwise.
- **The stream budget is exceeded by a layer we expected to fit** (a category with unusually
  long names). The decision must be made on measured bytes, never on a row-count guess.

## Requirements *(mandatory)*

### Functional Requirements

**The answer**

- **FR-001**: The system MUST answer a natural-language site-selection question with map
  layers as the primary output. Accompanying text is capped at two sentences (constitution I).
- **FR-002**: The system MUST emit three layers — competitors, an opportunity surface at H3
  resolution 8, and exactly three ranked recommendations — each as its own layer, appearing
  as its computation completes rather than in a single batch at the end.
- **FR-003**: Each of the three recommendations MUST carry the population and competitor
  count that produced its score, so a sceptic can recompute the ranking by hand.
- **FR-004**: The ranking MUST be deterministic: identical questions produce an identical
  top-3, including when scores tie.
- **FR-005**: The system MUST answer for any of the three loaded cities and any category
  present in the data, and MUST say plainly when a city or category is not held rather than
  rendering a misleading empty map.

**The score**

- **FR-006**: Supply MUST be counted over `h3kRing(h3_8, 1)` — the cell plus its six
  neighbours — not the single cell. A competitor 100 m away across a hex boundary is
  competition. *(Measured impact: ring supply reaches 64 where cell-local supply reaches 20;
  1,354 cells see a competitor versus 514 that contain one.)*
- **FR-007**: The score MUST NOT contain an invented saturation constant. Supply MUST be
  normalised by the same method as demand, derived from the data at query time. *(The
  inherited "3 = saturated" sits at the p75 of a distribution running to 64 — see Verified
  Measurements.)*
- **FR-008**: The score MUST keep the `demand × (100 − supply) / 100` shape — it is
  explainable in one breath to a judge, which is the reason it was chosen over anything more
  sophisticated.
- **FR-009**: Demand MUST come from the Kontur population data — actual residents, not a
  POI-density proxy.
- **FR-010**: Both normalisation MUST be robust to outliers, and the scaling method and its
  parameter MUST be stated in the spec and visible in the code, not buried as a literal.

**The stream**

- **FR-011**: The system MUST NOT fail a run because a layer is too large, for any question a
  user can ask.
- **FR-012**: The decision to send a layer inline or by reference MUST be made on the
  **measured serialized byte size** of that specific payload, never on a row-count heuristic.
- **FR-013**: Layers exceeding the budget MUST be delivered by reference: a small handle on
  the stream, with the geometry fetched by the browser **directly from ClickHouse** — no
  application server in the data path (ADR-003).
- **FR-014**: The by-reference path MUST be exercised by the primary demo, not reserved for
  the failure case. *(The res-8 choropleth is ~500 KiB against a 1 MiB hard cap — it has no
  safe margin, so it takes the by-reference path and the code cannot rot unnoticed.)*
- **FR-015**: Out-of-band layer data MUST expire automatically. A demo store must not grow
  without bound.
- **FR-016**: The model MUST receive only summaries (counts, extents) and never geometry
  (ADR-001, proven).

**Honesty and licence**

- **FR-017**: Kontur attribution (CC BY 4.0) MUST be displayed wherever the map is shown.
  This is a licence obligation, not a courtesy.
- **FR-018**: The population data MUST be presented as the 2023-11-01 snapshot it is. The
  product MUST NOT imply live demand.
- **FR-019**: The system MUST NOT present a modelled score as a measured fact. The score is a
  ranking heuristic over real inputs, and the UI must not overstate it.

**Cleanup**

- **FR-020**: `showSavedSites` and its deliberate double-write MUST be removed. It was
  scaffolding built to exercise the ADR-001 gate; that gate has passed and the scaffold's
  behaviour (writing the same layer twice on purpose) is a defect in a real tool.

### Key Entities

- **Place**: a real-world business or amenity — name, category, position, city, and its H3
  cells at resolutions 8 and 9. 211,818 loaded across Berlin, Amsterdam and Belgrade.
- **Population cell**: an H3 resolution-8 cell with an estimated resident count. Shares the
  Place's resolution-8 cell identity exactly, so demand and supply meet with no interpolation
  — this is why the score is honest rather than a raster guess.
- **Candidate cell**: a populated cell within the target city, carrying demand, ring supply,
  and the resulting opportunity score. The unit the answer is computed in and the unit the
  choropleth draws.
- **Layer**: one addressable visual overlay on the map — competitors, opportunity surface, or
  recommendations. Rewritable in place as it fills.
- **Layer handle**: a reference to layer geometry held outside the stream, resolvable by the
  browser directly against the database.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Asking "where should I open a bakery in Berlin?" produces a map with all three
  layers and no run failure, on 10 consecutive attempts.
- **SC-002**: The first layer is visible within 3 seconds of asking, and the complete answer
  within 15 seconds — the map must feel like it is thinking, not hanging.
- **SC-003**: No question a user can ask causes a run to fail from payload size — including
  the widest layer in the data (every Berlin POI, measured at 14.9 MiB, 14× the cap).
- **SC-004**: Each of the three recommendations can be hand-verified from the displayed
  population and competitor count in under a minute.
- **SC-005**: Re-asking the same question returns the same top-3 in the same order.
- **SC-006**: The prose in the answer never exceeds two sentences (constitution I).
- **SC-007**: The top-ranked cells are recognisable to someone who knows Berlin as dense
  residential areas underserved by bakeries. *(Baseline from the measured run: Mariendorf,
  Hellersdorf, Staaken, Köpenick — consistent with the day-2 exploration, and notably not the
  commercial centre a POI-density proxy would have chosen.)*
- **SC-008**: Kontur attribution is visible on every view that shows the map.

## Assumptions

- **Ring radius k=1 at resolution 8** models a walking catchment (~1.2 km across). Chosen for
  bakeries — a trade people walk to. Not revisited per-category on day 3.
- **Robust scaling at the 95th percentile** for both demand and supply, clamped to the range.
  p95 rather than max so a single outlier cell cannot flatten the rest of the city; the same
  method on both terms so the formula stays symmetric and explainable. The consequence is
  accepted: cells above p95 demand tie at the ceiling (measured: 3 cells at exactly 100.0),
  which FR-004's deterministic tiebreak covers.
- **A serialized-byte budget of 256 KiB** for inline layers — a 4× margin under the 1 MiB
  hard cap, leaving room for envelope overhead and concurrent parts. Measured layers fall
  cleanly either side: bakery dots 153 KiB inline, choropleth ~500 KiB by reference.
- **The by-reference store is ClickHouse itself**, reachable by the existing read-only `site`
  user over the already-proven open CORS (ADR-003). No new datastore is introduced.
- **Category matching is exact against the Overture taxonomy**, with a small synonym map for
  the demo questions ("bakery" → `bakery`). Free-text category inference is not attempted.
- **Land use is not modelled.** A high score means "many people, few competitors", not
  "a rentable ground-floor unit exists here".
- **City extent is a bounding box**, not an administrative boundary. Berlin's bbox holds
  4.25M people against ~3.6M in the city proper — it reaches into Brandenburg. Acceptable for
  ranking (the surrounding cells compete fairly), but it means the population total is not a
  census figure and must not be quoted as one.
- The three cities' data is already loaded and verified; no ingest work is in scope.

## Out of Scope *(constitution VI — the clock is not negotiable)*

Stated explicitly so it is not relitigated at 2am:

| Cut | Why |
|---|---|
| **Isochrones / drive-time catchments** | Day 4. The ring is the day-3 stand-in for a catchment, and it is honest about being one. |
| **Saved sites in the answer flow** (`oltp.pg_saved_sites`) | Day 4's OLTP surfacing. The CDC path is already built and verified (ADR-004); day 3 does not depend on it and must not block on it. |
| **Per-category ring radius, rent, footfall, land use, competitor quality** | Each is a real modelling improvement and none fit before 21 July. The score's honesty comes from stating what it omits, not from omitting less. |
| **Client-side slider re-weighting** | Day 5 if time allows. |
| **Resolution-9 choropleth** | Measured at ~2.2 MiB, and res-8 is already at the limit of what reads well as a city-wide surface. No rubric criterion moves. |
| **Surviving a page reload** (was US1 scenario 4) | **Cut 19 July, after testing it.** ADR-001 listed this as *assumed*; it is false. `useChat` mints a new `chatId` per mount, so a reload starts a fresh session. The SDK does support hydration (`sessions` + `onSessionChange` + `reconnectToStream`), but that resumes a **live stream** — a *finished* answer has no stream to resume, so restoring a completed map means replaying persisted parts, which is real work of uncertain size. It moves no rubric criterion and no demo reloads mid-answer. Revisit only if days 4-5 come in early. |
| **Vector tiles (MVT) from SQL** | Needs ClickHouse 26.6; Cloud is on 26.4 and trails ~2 releases. GeoJSON is fine at 3 cities. |
| **Any category-inference model** | A synonym map answers the demo questions; an LLM taxonomy mapper is a day of work for zero rubric points. |

## Dependencies

- `geo.places` — 211,818 POIs, H3 in MATERIALIZED columns (never inline — the trap is silent).
- `geo.population` — 475,535 Kontur cells at H3 res 8, joining to `geo.places.h3_8` on equality.
- `chat.agent()` with stable-`id` in-place part updates — **proven** on the live API, day 2.
- ClickHouse Cloud HTTP with open CORS and a read-only `site` user — **proven**, ADR-003.
- ClickHouse Cloud is **26.4**: no `GeoJSON` format, no MVT. GeoJSON is assembled by hand
  (`toJSONString` + `map()`). Assume 26.6 never arrives.
</content>
