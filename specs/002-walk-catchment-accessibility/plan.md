# Implementation Plan: The walk catchment, and Accessibility as a real factor

**Branch**: `002-walk-catchment-accessibility` | **Date**: 2026-07-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-walk-catchment-accessibility/spec.md`

## Summary

Put the Valhalla isochrones we have held since 17 July on screen, and let them change the
answer. Three moves, in dependency order:

1. **`scoring.ts` grows a third term.** `candidateCells` gains an `acc` CTE — centre child at
   res 9 → `geo.isochrone_cells` at 10 minutes → `h3ToParent` → `geo.population`. `gap` becomes
   a three-term product. Measured at **669 ms** for Berlin, against ~700 ms today: free.
2. **A fourth tool, `showCatchment`**, re-derives the #1 pick and emits its real contour as a
   new `catchment` layer — the first geometry in this product that came from routing.
3. **The client gains a factor and a state.** `FACTORS` takes a third entry (the file was built
   for it); the choropleth learns to render a cell whose accessibility is *absent* — a state,
   not a zero.

The load-bearing decision is #3's rendering, and it is in [research.md](./research.md) D3: an
unmeasured cell's "not measured" styling is **opacity-graded by its remaining score**, because
735 of Berlin's 830 unmeasured cells are already invisible and flat-filling them would bury the
6 that matter under 735 that don't.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 26, React 19 / Next.js (app router)

**Primary Dependencies**: `@trigger.dev/sdk` (chat.agent), `@ai-sdk/anthropic` → DeepSeek,
`@clickhouse/client`, `maplibre-gl`, `zod`

**Storage**: ClickHouse Cloud 26.4.1.2029 — `geo.isochrones`, `geo.isochrone_cells`,
`geo.population`, `geo.places`, `geo.districts`, `web.layers`. **No new tables, no new indexes,
no reload.** The isochrone tables were shaped for exactly this join.

**Testing**: `pnpm verify:score` (scripts/verify-score.mjs) — pulls real cells from ClickHouse
and compares all three encodings of the formula. Plus a new live check for the reaches-self
invariant. Manual live run for the agent's prose (US3).

**Target Platform**: browser (MapLibre) + Trigger.dev task

**Project Type**: web application — Next.js front end, Trigger.dev agent back end

**Performance Goals**: choropleth query ≤ ~1 s (measured 669 ms); slider recolour with no
network round-trip and no re-serialisation (paint property only, as today)

**Constraints**: Cloud is 26.4 — no `GeoJSON` output format, no MVT; assemble GeoJSON in SQL by
hand. ~1 MiB chat-stream record cap — `emitLayer` decides inline vs handle on measured bytes.
H3 ordering is not uniform (`h3ToGeo`/`geoToH3` lat-first; `h3PolygonToCells` lon-first).

**Scale/Scope**: 4,075 populated cells across three cities; 635,080 reachable-cell rows;
63,479 contours. One new tool, one new layer, one new factor.

## Constitution Check

*GATE: must pass before Phase 0. Re-checked after Phase 1 — see below.*

| Principle | Status | Evidence |
|---|---|---|
| **I. The answer is a visual artifact** | **PASS** | The deliverable is a shape on a map that follows streets. The one prose change (US3) *narrows* what the model may say. The not-measured state is a colour, not a disclaimer paragraph. |
| **II. Claims verified against the live system** | **PASS** | Every number in spec/research was executed on 26.4.1.2029, 17 Jul. The spec's own prose was audited separately and **one claim was found wrong** (346 → 375 residents) and one unverified-but-true claim was checked (Belgrade density). See [checklists/requirements.md](./checklists/requirements.md). |
| **III. Prove the riskiest path first** | **PASS** | The riskiest thing here was never the UI — it was whether the accessibility join is fast enough and whether coverage kills the feature. Both were executed **before** the spec was written: 467 ms, 92.7–97.5% of population covered, all three demo picks covered. |
| **IV. Infrastructure is reproducible code** | **PASS — N/A** | No infrastructure changes. `infra/valhalla.sh` already built and verified this data; this feature only reads it. |
| **V. Secrets never enter git** | **PASS** | No new credentials. The client reads `web.layers` as the existing readonly `site` user. |
| **VI. Scope bounded by the clock** | **PASS** | Clock checked (`date -u`): **5 d 22 h** remain at planning time, against a plan that had budgeted this as "day 4". Nothing is cut for schedule. Four things *are* cut for lack of value — see spec's "What this cuts". |

**Post-Phase-1 re-check: PASS.** The design added no new entity, table, service or dependency.
The one thing it added that the spec did not anticipate is FR-009a/b (opacity-graded
not-measured, and its disappearance at weight 0) — both of which *reduce* complexity: they fall
out of the existing ramp and the existing exponent maths rather than adding a mechanism.

## Project Structure

### Documentation (this feature)

```text
specs/002-walk-catchment-accessibility/
├── plan.md              # This file
├── spec.md              # The feature spec
├── research.md          # Phase 0 — the seven decisions, each with its query
├── data-model.md        # Phase 1 — entities and the absent-value contract
├── quickstart.md        # Phase 1 — how to prove it works
├── contracts/
│   └── layer-catchment.md   # The catchment layer part + tool contract
└── checklists/
    └── requirements.md  # Spec quality gate, incl. the prose audit
```

### Source Code (repository root)

```text
web/src/
├── trigger/
│   ├── scoring.ts       # CHANGED: acc CTE in candidateCells; gap becomes 3-term;
│   │                    #          accP95 + notMeasured out of choroplethStatsSql;
│   │                    #          `acc` in choropleth GeoJSON properties (omitted when absent);
│   │                    #          NEW catchmentSql() — contour lobes for one origin
│   ├── chat.ts          # CHANGED: showCatchment tool; SYSTEM_PROMPT walk ban narrowed
│   └── layers.ts        # CHANGED: LayerId += "catchment"; Scale += accP95;
│                        #          MapData += notMeasured count
└── components/
    ├── score.ts         # CHANGED: FACTORS += accessibility; CellProps.acc?: number;
    │                    #          gapOf/gapExpression handle an absent term
    └── chat.tsx         # CHANGED: WAVES += catchment; catchment source+layer+toggle;
                         #          not-measured paint; CATCHMENT · MEASURED chip;
                         #          not-measured counter in the rail

scripts/
└── verify-score.mjs     # CHANGED: three factors, three cities, absent-acc cells

db/clickhouse/
└── 006_isochrones_schema.sql   # UNCHANGED — documentation only; this feature reads it
```

**Structure Decision**: no new files in `web/src` beyond what exists. This feature is
deliberately shaped as *changes to the five files that already own these concerns* — the score
is defined once in `scoring.ts` and re-derived once in `score.ts`, and that pairing is the thing
`verify:score` protects. A new "accessibility service" module would be a third place for the
formula to drift.

## Implementation order — riskiest first (constitution III)

1. **`scoring.ts`: the `acc` CTE and the 3-term gap.** Everything else is downstream. Prove it
   against all three cities and confirm the measured top-3 shift is the one research.md D1
   predicts.
2. **`verify-score.mjs` + the reaches-self check.** Before any UI. The invariant that catches a
   backwards join must exist before there is a map to make a backwards join look plausible.
3. **`score.ts`: the third factor and the absent term.** Then `verify:score` must be green with
   three factors across three cities, still 0 mismatches.
4. **The catchment layer** (`catchmentSql` → `showCatchment` → `LayerId` → paint). US1 is
   independently shippable and is the wow shot; it lands whole.
5. **The client's not-measured state + counter + chip + wave.**
6. **US3's prompt narrowing — last**, behind the data, and verified by diffing the live prose
   against the tool payload.

## Complexity Tracking

> No constitution violations. Table intentionally empty.

The one deviation worth recording is not a violation but a **deliberate departure from the
design comp**: the comp's 7-wave rail places "Walk catchment · Valhalla" between the competitor
dots and the opportunity surface. It cannot go there, because the catchment is the catchment
*of a pick* and the picks are ranked last. The rail order becomes read → competitors →
opportunity → picks → catchment → caption. The comp was drawn before the data existed; the data
wins.
