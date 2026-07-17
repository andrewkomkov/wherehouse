# Quickstart — proving the walk catchment and Accessibility actually work

Every check below is runnable. Where a check has a **known-bad twin**, run that too: a check
that has never failed is decoration (`infra/valhalla.sh`'s own lesson, day 4).

## Prerequisites

```sh
./infra/check-env.sh          # every credential against the live services, ~5 s
```

The ClickHouse service idles after 15 min; the first query wakes it and may be slow. **A single
timeout is not an outage.**

## 0. The data this feature reads is still there

```sh
set -a && source .env && set +a
curl -s --user "default:$CLICKHOUSE_PASSWORD" "$CLICKHOUSE_URL/" --data-binary "
SELECT 'cells' t, count() FROM geo.isochrone_cells
UNION ALL SELECT 'contours', count() FROM geo.isochrones FORMAT PrettyCompact"
```

**Expected**: 635,080 and 63,479. If either is 0, `infra/valhalla.sh` was re-run and failed —
it drops the partition it wrote rather than leaving bad data, so an empty table is the *safe*
failure, not a mystery.

## 1. The score

```sh
cd web && pnpm verify:score
```

**Expected**: `0 mismatches` across all three cities, now with three factors. This is the check
that the SQL, the JS and the MapLibre expression are one formula rather than three.

**Its known-bad twin** — prove it can fail. Temporarily change `acc_p95` to `acc_p90` in
`scoring.ts` alone and re-run: it must report mismatches. Revert. If it stays green, the check
is not reading what you think it is.

## 2. The invariant that catches a backwards join

```sh
curl -s --user "default:$CLICKHOUSE_PASSWORD" "$CLICKHOUSE_URL/" --data-binary "
WITH cells AS (SELECT h3_8, population FROM geo.population
    WHERE country='DE' AND h3ToGeo(h3_8).1 BETWEEN 52.338 AND 52.675
      AND h3ToGeo(h3_8).2 BETWEEN 13.088 AND 13.761),
  o AS (SELECT h3_8, population, h3ToCenterChild(h3_8, 9) AS origin FROM cells)
SELECT countIf(reaches_self = 0) AS must_be_zero, count() AS measured_cells
FROM (SELECT o.h3_8, maxIf(1, h3ToParent(ic.reachable_h3_9, 8) = o.h3_8) AS reaches_self
  FROM o INNER JOIN geo.isochrone_cells ic
    ON ic.origin_h3_9 = o.origin AND ic.minutes = 10 AND ic.city='berlin'
  GROUP BY o.h3_8) FORMAT PrettyCompact"
```

**Expected**: `must_be_zero = 0`, `measured_cells = 1430`.

**Why this is the check and not a row count**: a cell must be able to walk to itself. If the
origin→reach join is ever wired backwards, this fails loudly — while a row count would still
look entirely plausible. That is the exact shape of the three H3 ordering bugs this project has
already shipped: no error, no empty result, just a confident wrong answer.

## 3. Coverage is what we say it is (spec SC-006)

Re-measure rather than trust the spec's table:

```sh
# per city: measured cells, % of cells, % of POPULATION
# expected: berlin 1430 / 63.3% / 92.7% · amsterdam 649 / 87.8% / 97.0% · belgrade 894 / 83.1% / 97.5%
```

**The population column is the one that matters.** 63.3% of Berlin's *cells* sounds alarming;
92.7% of Berlin's *residents* is the truth, and the gap between those two numbers is the whole
reason the unmeasured cells are mostly invisible on screen.

## 4. The answer changed, and changed defensibly (spec SC-007)

Ask the primary question live: **"where should I open a bakery in Berlin?"**

**Expected**: picks #1 and #2 unchanged (`881f18b021`, `881f1d4d81`). Pick #3 is now
`881f18b563` — Berlin's densest cell, 8,693 residents, 12,942 reachable on foot — displacing
`881f18b645`, whose residents are real but whose detached-house streets a 10-minute walk cannot
reach.

**Look at the map, not the numbers.** The claim "this suburb's residents are unreachable on
foot" is checkable by eye: the displaced cell's contour should be visibly stringy and thin.
If pick #3 changed for a reason you cannot see on the map, that is a rounding artefact, not a
feature.

## 5. The wow shot (US1)

**Expected**, in this order, without touching anything: competitor dots → opportunity surface →
three pins → **a contour around pin #1 that follows streets**, stops at rail cuttings, and is
unmistakably neither a circle nor a hexagon. The rail's "Walk catchment · Valhalla" row goes
`○ → ◐ → ●`, and `CATCHMENT · MEASURED` appears under the caption.

Toggle "Walk catchment" off and on: nothing else on the map may move.

## 6. The not-measured state (US2)

At **neutral** — accessibility is weighted 33%, so this is visible immediately:

- ~830 Berlin cells render in the not-measured hue, and **735 of them are barely visible**,
  because their opacity is driven by their remaining score. That is correct, not a bug.
- The ~6 cells that score ≥ 40 on residents and competition **announce themselves**. Those are
  the point: they look promising and we could not measure their walk.
- The rail shows `830 cells · not measured`.

Drag **Accessibility to 0**: the not-measured cells rejoin the surface with a normal colour, and
the count and styling disappear. Drag it back: they leave again. No special case does this — the
exponent goes to 0 and the factor drops out of the product.

**The failing twin**: set an unmeasured cell's `acc` to `0` instead of omitting it (in
`scoring.ts`). The cell must go *black and stay ranked* rather than not-measured — if it still
renders as not-measured, the client is testing for falsiness rather than absence, and `acc =
0.286` (a real, verified measurement) will be misreported as unmeasured.

## 7. The agent may say "walk" — and only where it measured one (US3)

Ask the primary question and read the caption.

**Allowed**: a walk claim sourced from `showCatchment`'s `reachablePeople`.

**A regression**: *any* walk/catchment/travel-time language attached to the competitor count.
`sup` is `h3kRing(h3_8, 1)` — a ring measured live at **1.391 km** across. It is walkable, which
is exactly why the phrase sounds right, and it is not a walk.

**How to check it, and this is the part that is easy to get wrong**: do not grep the prose for
the word "walk". Pull the tool payloads out of the run and confirm every walk claim traces to
`reachablePeople`. 001 learned this the expensive way — the old guard searched for capitalised
words and the invariant had inverted underneath it. Check the claim that was actually made.
