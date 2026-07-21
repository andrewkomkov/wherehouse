# Feature Specification: Consultant-Grade Ranking Variety

**Feature Branch**: `main` (single-branch hackathon repo)

**Created**: 2026-07-20

**Status**: Implemented — shipped and deployed to prod (agent + UI) 2026-07-21

**Input**: User description: turn WhereHouse from a top-3 calculator that returns the *same three pins* to every question into a consultant that can vary **which** places it surfaces — alternatives beyond the top 3, the worst/saturated places, a single district, and different strategic lenses.

## Problem

Today `rankSites` always asks for the global top-3 by one balanced GAP formula with a fixed tiebreak. Every re-weighting returns the *same three pins*, because those genuinely are the global optimum. The agent cannot show alternatives, cannot show where **not** to open, cannot rank inside a chosen neighbourhood, and cannot offer a different strategic angle. A user who says *"show me other options / the worst spots / the best place in Neukölln"* is told, truthfully but uselessly, that there is nothing else — the assistant behaves like a calculator, not a consultant.

Verified live (ClickHouse 26.4, 2026-07-20) that the variety already exists in the data and only the query surfaces it:

- Berlin / bakery, **balanced** top-3 = Tempelhof-Schöneberg, Marzahn-Hellersdorf, Treptow-Köpenick (the "always same 3").
- Ranking the same cells by **resident population** surfaces Charlottenburg-Wilmersdorf cells (8,000+ residents, gap 0) — huge but saturated markets the balanced answer never mentions.
- **Worst** (lowest gap among populated cells) surfaces Charlottenburg cells with 62–64 rivals — a real "avoid, already packed" answer.
- District names live in `geo.districts` at two tiers, `locality` (e.g. *Friedrichshain-Kreuzberg*, *Neukölln*) and finer `area` (e.g. *Kreuzberg*, *Köpenick*). *Kreuzberg* exists **only** as an `area`, so a district filter must match either tier; matching is case-insensitive and umlaut-safe.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A different strategic lens (Priority: P1)

A user has seen the balanced picks and asks for a different angle: *"where's the biggest market, even if it's competitive?"*, *"where is competition lowest?"*, *"where's the best foot traffic?"*. The agent re-ranks the **same** scored cells under a named strategy and moves the pins to the cells that strategy favours, saying which lens it used.

**Why this priority**: This is the core of the complaint — one question, one set of pins, no way to see the market from another angle. It delivers the "consultant" feeling on its own and is the smallest slice that fixes the reported defect.

**Independent Test**: Ask the balanced question, then ask for the "biggest market" lens; the pins move to different cells (verified: Charlottenburg vs Tempelhof for Berlin/bakery), and the agent states the lens it applied. Delivers value even if Stories 2–4 are never built.

**Acceptance Scenarios**:

1. **Given** a balanced answer is on screen, **When** the user asks for the biggest-market lens, **Then** the pins move to the highest-demand cells and the caption names the lens as a lens, not as "the" answer.
2. **Given** the demand lens is applied, **When** the user asks to go back to balanced, **Then** the pins return to the exact original three (the balanced default is byte-for-byte unchanged).
3. **Given** any lens, **When** the same lensed request is repeated, **Then** the identical pins are returned (deterministic within the lens).

### User Story 2 - Where NOT to open (Priority: P1)

A user asks *"where should I avoid?"* / *"show me the worst spots"*. The agent pins the most **saturated** cells that still have real demand — places already packed with rivals — and frames them as a warning, never as "bad places".

**Why this priority**: A consultant's value is as much in ruling places out as in ranking them in. It is a distinct, high-signal answer the current tool cannot produce at all, and it reuses the same scored cells (only the order flips).

**Independent Test**: Ask "where should I avoid opening a bakery in Berlin"; pins land on high-rival, high-population cells (verified: 62–64 rivals in Charlottenburg), and the caption frames them as saturated/avoid.

**Acceptance Scenarios**:

1. **Given** a city and trade, **When** the user asks for the worst/most-saturated places, **Then** the pinned cells are populated cells with the lowest opportunity (highest saturation), not empty fields.
2. **Given** worst-mode pins are shown, **When** the caption is written, **Then** it frames them as "already saturated / avoid", never as inherently bad locations.

### User Story 3 - Best in one district (Priority: P2)

A user asks *"where's the best place for a bakery in Neukölln?"*. The agent ranks only cells inside that named district and states the answer is limited to it.

**Why this priority**: Local knowledge is exactly what a consultant is asked for, and it is a natural follow-up. It depends on the same ranking machinery plus a name filter, so it is lower risk once Story 1 exists.

**Independent Test**: Ask for the best bakery spot in Neukölln; every pin resolves to that district and the caption says the answer is limited to Neukölln. Ask for an unknown district and get a relayed error listing real districts, never an empty map.

**Acceptance Scenarios**:

1. **Given** a real district name (matching either name tier, any case, umlauts included), **When** the user asks for the best spot there, **Then** all pins fall inside that district and the caption states the scope.
2. **Given** a name that matches no district, **When** the user asks, **Then** the agent relays an error naming some available districts and draws no pins — never an empty or misleading map.
3. **Given** a district filter combined with a strategy or worst-mode, **When** the user asks, **Then** both constraints apply together.

### User Story 4 - More options / alternatives (Priority: P2)

After seeing the picks, the user asks *"show me more options"*. The agent surfaces further ranked cells beyond the ones already shown, up to six pins on screen at once for side-by-side comparison.

**Why this priority**: "Is that really all?" is the literal complaint. Paging past the top few is the direct answer, and six concurrent pins let the user compare rather than accept a fixed three.

**Independent Test**: Ask the question, then "show me more"; additional distinct ranked cells appear (the next page), and the on-screen pin count can reach six without the earlier ones silently vanishing into an unexplained set.

**Acceptance Scenarios**:

1. **Given** an answer with the first N picks, **When** the user asks for more, **Then** the next ranked cells (beyond those already shown) are surfaced, up to a six-pin ceiling.
2. **Given** six pins are shown, **When** each is inspected, **Then** every pin carries its own rank, score and provenance exactly as the top pick does today.
3. **Given** paging has reached the end of meaningful candidates, **When** the user asks for still more, **Then** the agent says there are no further distinct options rather than repeating or inventing cells.

### Edge Cases

- **Balanced regression**: the default (no lens, no district, best order, first page) must reproduce today's exact three picks — a moved default is a defect, not a feature.
- **Divergent surface**: under a non-balanced lens the pins no longer sit on the reddest choropleth cells (the surface stays balanced). This divergence must be stated, never hidden — a pin off the hot zone must be explained by its lens.
- **District with no finer tier**: Belgrade cells are usually `locality`-only (finer `area` ~3.9%). A locality-only match is a normal success, not a failure.
- **Empty worst-set**: a trade with almost no rivals anywhere has no meaningfully "saturated" cells; the worst answer must degrade honestly, not manufacture a warning.
- **District smaller than the requested page**: a small district may hold fewer than six rankable cells; the answer shows what exists and says so, never pads to six.
- **Unmeasured cells**: cells with no measured walk stay excluded from ranking exactly as today (their score omits the accessibility term); no lens re-admits them.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The ranking tool MUST accept an optional **strategy lens** — one of *balanced* (default), *demand* (biggest market), *low-competition* (most headroom vs rivals), *accessible* (best measured 10-minute-walk residents) — and reorder the same scored candidate cells accordingly.
- **FR-002**: The *balanced* lens MUST reproduce the current answer exactly (same formula, same cells, same order, same tiebreak). Changing this feature MUST NOT move the default answer.
- **FR-003**: Strategy lenses MUST be stated **presets over the existing normalized factors** (demand, competition-headroom, accessibility), not new measurements. The system MUST NOT invent a new score, a rent factor, or any factor without data behind it.
- **FR-004**: The ranking tool MUST accept an optional **order** — *best* (default) or *worst* — where *worst* surfaces the most **saturated cells that still have real demand** (populated), framed as places to avoid.
- **FR-005**: The ranking tool MUST accept an optional **district name** and, when given, rank only cells inside that district. Matching MUST test both district name tiers, case-insensitively and umlaut-safely.
- **FR-006**: A district name matching nothing MUST return a relayed error that names available districts; it MUST NOT draw an empty or misleading map (an empty map reads as "nowhere is good", a confident lie).
- **FR-007**: The ranking tool MUST support **paging** beyond the first set of picks, so "more options" surfaces the next distinct ranked cells rather than repeating the shown ones.
- **FR-008**: Up to **six** ranked pins MUST be displayable at once, each with its own rank, score, place name and provenance, matching the fidelity of today's top pick.
- **FR-009**: Every request MUST be **deterministic** within its (lens, order, district, page): the same request yields the same pins, via an explicit total order with a stable cell tiebreak.
- **FR-010**: The agent's words and the on-screen labelling MUST make the active lens/order/district explicit: a non-balanced answer is presented **as a lens**, worst-mode **as saturation/avoidance**, a district answer **as scoped to that district** — never as the single definitive answer.
- **FR-011**: When pins under a non-balanced lens fall off the balanced opportunity surface's hot zone, the answer MUST acknowledge that the pins follow the chosen lens while the coloured surface stays the balanced opportunity — the two are not expected to coincide.
- **FR-012**: All place names the agent utters MUST still come only from tool-returned `place` values (no invented districts); the new district-filter path MUST NOT become a new place-name hallucination surface.
- **FR-013**: The feature MUST NOT add new data sources, change the balanced GAP formula, resolve districts by anything beyond name-contains matching on the two tiers, or expose per-pin custom weights (the existing re-weight sliders own that).
- **FR-014**: The existing mandatory build sequence (competitors → opportunity → rank → catchment) MUST keep working with no extra arguments; all new parameters are optional with the defaults above.

### Key Entities *(include if feature involves data)*

- **Ranking request**: a (city, trade, strategy lens, order, district, page) tuple. Only city and trade are required; the rest default to the balanced global top set.
- **Scored candidate cell**: an H3 cell already carrying demand, supply and accessibility factors and the balanced gap — the single source of truth every lens reorders, unchanged by this feature.
- **District**: a named area with two name tiers (broad `locality`, finer `area`); used only to filter candidate cells by name, never to score them.
- **Pin (ranked pick)**: a surfaced cell with a rank, a score under the active lens, a place name and its provenance numbers; up to six on screen.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For at least one demo city and trade, the *demand*, *low-competition* and *worst* answers each surface a top cell that the *balanced* answer does **not** — i.e. the "same three pins" complaint is objectively gone (verified live: balanced Tempelhof vs demand/worst Charlottenburg for Berlin/bakery).
- **SC-002**: Re-asking the balanced question after this feature ships returns the **identical** three picks as before it shipped.
- **SC-003**: A "best in <district>" request places 100% of its pins inside the named district across all three cities, or returns a clear no-match error naming real districts.
- **SC-004**: A "more options" request shows strictly new ranked cells beyond those already displayed, reaching up to six concurrent pins.
- **SC-005**: In every non-default answer, a reader can tell from the caption alone which lens/order/district produced the pins — no non-balanced answer is presented as the definitive one.
- **SC-006**: No place name appears in the agent's prose that was not in a tool payload (the day-3 hallucination guard still holds through the new district path).

## Assumptions

- The re-weight sliders remain the mechanism for arbitrary custom weights; strategies are a small fixed set of named presets, not a continuous space.
- Six is the pin ceiling; "more" past the last meaningful candidate is answered honestly, not padded.
- District resolution is name-contains on the two existing tiers; no gazetteer, geocoder, or fuzzy/LLM matching is added.
- The opportunity choropleth stays the balanced surface; lenses move pins, not the surface. (Re-colouring the surface per lens is out of scope for this feature.)
- The city set stays Berlin/Amsterdam/Belgrade and the trade set stays the trades already exposed; no new cities or trades.
- Determinism relies on the existing stable cell tiebreak carried through into every new ordering.

## Out of Scope

- Recolouring the opportunity surface to match a non-balanced lens.
- Custom/continuous per-factor weights via the ranking tool (owned by the re-weight sliders).
- Fuzzy, multilingual, or geocoded district resolution beyond name-contains.
- More than six concurrent pins.
- Any change to the balanced GAP formula or the underlying data.
