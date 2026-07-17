# Phase 0 — Research: the walk catchment and Accessibility

Every decision below was made by running a query, not by reasoning about one. Measured
2026-07-17 against ClickHouse Cloud 26.4.1.2029.

---

## D1. Accessibility is a factor in the **server's** score, not a client-side toy

**Decision**: `gap = demand_n × (100 − supply_n)/100 × acc_n/100` — a three-term product,
computed in `scoring.ts`, ranked on by the agent.

**Rationale**: `score.ts`'s load-bearing invariant is *"at NEUTRAL weights, this file MUST
produce the number ClickHouse already produced."* Neutral with three factors means every
exponent is 1, i.e. the plain three-term product. So either the server computes the third term
too, or the invariant breaks the moment the slider exists. The file's own header already
anticipated this: *"Adding a third factor (accessibility, once Valhalla isochrones land) is one
entry in FACTORS below — no rewrite."* The architecture decided this before we did.

It is also what "honest" means: a factor that cannot change the answer is a decoration with a
slider attached.

**Consequence, measured — the answer changes, and it changes for the better.**

Berlin bakeries, `ORDER BY gap DESC, pop DESC, cell ASC`:

| rank | 2-factor (today) | pop | 3-factor (this feature) | pop | reachable in 10 min |
|---|---|---|---|---|---|
| 1 | `881f18b021` | 6,826 | `881f18b021` — unchanged | 6,826 | 14,780 |
| 2 | `881f1d4d81` | 6,807 | `881f1d4d81` — unchanged | 6,807 | 11,864 |
| 3 | `881f18b645` | 5,860 | **`881f18b563`** — new | **8,693** | 12,942 |

The top two hold. The third changes: `881f18b645` (Mahlsdorf, per 001's district resolution)
is displaced by Berlin's **densest populated cell** (8,693 — the max in the whole bbox).

**Why that is the right answer and not a regression**: Mahlsdorf has 5,860 residents in its own
hex but is detached-house sprawl, so a 10-minute walk from its centre reaches comparatively few
of them. The new cell has more residents *and* a walk that reaches 12,942 people. The product
demotes the cell whose residents are real but unreachable — which is precisely the failure a
hexagon-count score cannot see, and the entire reason the isochrones exist.

**Alternatives rejected**:
- *Client-only accessibility (server stays 2-factor)* — breaks `score.ts`'s neutral invariant,
  the one property `pnpm verify:score` exists to defend.
- *Geometric mean (exponents summing to 1, not N)* — would keep the score's numeric range
  stable as factors are added, but it redefines the documented GAP formula (`demand ×
  (100 − supply)`) whose whole virtue is being explainable in one breath. Rejected: range
  stability is a presentation problem, and it must not be solved by changing the meaning of
  the score.

---

## D2. The origin is the cell's **centre child** at res 9 — one rule, used twice

**Decision**: `h3ToCenterChild(h3_8, 9)` is the origin, for both the accessibility term and the
drawn contour.

**Rationale**: it makes the drawn shape and the scored number the *same measurement*. If the
contour came from one child and the score from another, the map would be illustrating a
different claim than the rail — the class of silent disagreement this project keeps paying for.

**Coverage cost, measured** (`% cells` / `% of population`):

| | centre child | any covered child |
|---|---|---|
| berlin | 63.3 / **92.7** | 68.8 / 94.3 |

5.5pp of cells, 1.6pp of population, in exchange for a rule that fits in a sentence and can be
falsified in one query. "The catchment from the centre of the cell" is defensible to a judge;
"the catchment from whichever of seven corners happened to route" is not.

---

## D3. "Not measured" inherits the ramp's opacity — it does **not** flood the map with grey

**Decision**: an unmeasured cell renders in a distinct hue, but at an opacity driven by its
**two-factor** score. Cells that are invisible today stay invisible; a cell that would have been
bright stays bright, in the not-measured hue.

**Rationale — this is the measurement that changed the design.** The first instinct (flat grey
for all 830 unmeasured Berlin cells) was checked before it was built:

| Berlin cells | count | median 2-factor gap | `gap < 15` (ramp is ~transparent) | `gap ≥ 40` (clearly visible) |
|---|---|---|---|---|
| **unmeasured** | 830 | **2.8** | **735** | **6** |
| measured | 1,430 | 26.3 | 518 | 512 |

**735 of the 830 are already near-invisible.** Painting them grey would light up 735 hexes of
empty Brandenburg fringe, water and parkland that the ramp currently — correctly — renders as
almost nothing. The map would get noisier and the eye would be dragged to the least interesting
region on screen, in the name of honesty.

But **6 cells score ≥ 40 today (max 49.1)**. Those are the whole problem: they look promising on
residents and competition, and under the three-factor score they would silently vanish from the
ranking. Those are the six that must announce themselves.

Opacity-by-2-factor-score does exactly that: it says *"this would have been interesting, but we
could not measure its walk"* with a loudness proportional to how interesting. It is the same
discipline the ramp already uses — alpha encodes how much you should care.

**Alternatives rejected**:
- *Flat grey for all unmeasured cells* — see above; honest in intent, worse on screen, and it
  buries the six cells that matter under 735 that don't.
- *Hatch/fill-pattern* — needs a generated sprite via `addImage`; more code, and it fights the
  ramp's alpha for the same signal. Revisit only if the hue alone reads ambiguously.

---

## D4. The unmeasured cells return the moment Accessibility is weighted to zero

**Decision**: no special case. The exponent form already does it: at weight 0 the exponent is 0,
`acc⁰ = 1`, the factor drops out of the product, and the cell is scoreable again on the other
two. The not-measured styling and its counter are shown iff the accessibility weight is > 0.

**Rationale**: it falls out of the maths rather than being bolted on, and it is the honest
reading of the interaction — *"if you don't care about the walk, we can score these cells after
all."* It also gives the user a way to see what the third factor is doing: drag it to zero and
the map returns to the two-factor answer, cells and all.

Note this makes the "not measured" state **visible at neutral**, without the user touching
anything — which is what we want (SC-002).

---

## D5. The contour is drawn for pick #1 only, by a **separate tool**

**Decision**: a fourth agent tool, called after `rankSites`, which re-derives the top pick with
the same `rankSql` and emits a `catchment` layer for its centre child at 10 minutes.

**Rationale**:
- *Separate tool, not folded into `rankSites`*: it is a visible extra step in the assembly rail
  with `Valhalla` as its named source, and a fourth ClickHouse-backed tool is depth against the
  25% criterion. The wave is real work, not a re-render.
- *Re-derives rather than taking an h3 argument*: passing the h3 through the model is a
  hallucination surface for no gain. `rankSql` is a total order (001, FR-004) so re-running it
  is deterministic, costs ~700 ms, and matches how every other tool already works (each re-runs
  `candidateCells`). No state, no trust in the model's copy-paste.
- *#1 only*: three overlapping contours read as mud. The comp puts a band around the winner.

**Wave order deviates from the comp, deliberately**: the comp places "Walk catchment · Valhalla"
between the competitors and the surface. It cannot go there — the catchment is *of a pick*, and
the picks come last. Order is: read → competitors → opportunity → picks → **catchment** →
caption. The comp was drawn before the data existed.

---

## D6. Timing — the third factor is free

**Measured**: the full three-factor choropleth query, both joins included, **669 ms** for Berlin
(2,260 cells). Today's two-factor choropleth is ~700 ms. The accessibility join adds nothing
measurable: it is an equality join on the sort key of both tables, which is the case
`isochrone_cells` was shaped for (`ORDER BY (origin_h3_9, minutes, reachable_h3_9)`).

Standalone accessibility aggregate: 467 ms. Contour lookup for one origin: sub-second (the
schema documents 24.6 ms for a cold single-origin catchment read).

No new index, no new table, no reshaping. The data was built for this query.

---

## D7. The ramp is left alone — for now, and this is flagged, not settled

**Measured**, Berlin bakeries over the 1,430 measured cells:

| | median | p90 | max | cells ≥ 40 |
|---|---|---|---|---|
| 2-factor `gap` | 26.3 | 74.7 | 100 | 512 |
| 3-factor `gap` | **6.9** | **54.7** | 100 | **263** |

A third term ≤ 1 compresses the product: the surface gets darker and half as many cells read as
"clearly opportunity". That is the honest consequence of requiring three conditions instead of
two, and 263 bright cells across Berlin is still a populated map.

**Decision: ship the ramp unchanged and look at it on screen before touching it.** Re-stopping
the ramp is a legitimate presentation choice (the same kind as p95 scaling), but re-stopping it
*so the demo looks good* is decoration, and the difference between those two is only visible
with the real map in front of you. This is the one open item in this plan; it is cosmetic, it
is reversible, and it must not be decided from a percentile table.
