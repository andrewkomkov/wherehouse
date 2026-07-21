# Implementation Plan: Consultant-Grade Ranking Variety

**Branch**: `007-consultant-ranking-variety` (dir) / `main` (git) | **Date**: 2026-07-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/007-consultant-ranking-variety/spec.md`

## Summary

`rankSites` today always asks `rankSql(city, cats, 3)` — the global top-3 by the balanced GAP with a fixed tiebreak — so every question returns the same three pins. This feature makes the ranking tool vary **which** cells it surfaces along four optional axes — strategy lens, best/worst order, district filter, and count+paging — all reordering/filtering the **same** `scored` candidate-cell CTE. The balanced default is byte-for-byte unchanged; every non-default answer is labelled as a lens. The client extends from 3 to up to 6 ranked pins. No new data, no formula change.

## Technical Context

**Language/Version**: TypeScript (Node 26, Trigger.dev task) + SQL (ClickHouse Cloud 26.4)

**Primary Dependencies**: `@trigger.dev/sdk/ai` (`chat.agent()`), `ai` + `@ai-sdk/anthropic` (DeepSeek), `@clickhouse/client`, `zod`; React client `web/src/components/chat.tsx` + MapLibre.

**Storage**: ClickHouse `geo.population`, `geo.places`, `geo.districts`, `geo.cell_capacity`, `geo.addr_density`, `geo.isochrone_cells` — all already loaded. **No new tables, no new columns.**

**Testing**: live SQL probes against the running service (constitution II); a headless `chat.agent()` run per `wherehouse-validate`; a balanced-regression check that the default picks are unchanged.

**Target Platform**: Cloudflare Worker (prod) + browser; local `pnpm dev` + `trigger dev`.

**Project Type**: web application (Trigger.dev agent backend + Next static client).

**Performance Goals**: rank query stays sub-second (same CTE, adds only an ORDER BY expression, a WHERE and an OFFSET); pins ≤ 6 so no payload concern (picks GeoJSON is tiny, always inline).

**Constraints**: Cloud is 26.4 (no `GeoJSON` format — geometry still assembled by hand); the ≤1 MiB stream cap is untouched (picks are small); place-name hallucination guard must survive the new district path.

**Scale/Scope**: 3 cities, the already-exposed trades. Server: `scoring.ts` + `chat.ts`. Client: `chat.tsx` (pins/rail/focus/colours) — one file. No infra change.

## Constitution Check

*GATE: must pass before Phase 0 and re-checked after Phase 1.*

- **I. Answer is a visual artifact** — PASS. The whole feature moves *pins on the map*; the model still returns only summaries and a two-sentence caption. No new prose surface; the lens is shown as a UI badge, not narrated at length.
- **II. Claims verified against the live system** — PASS. Variety, district matching (area OR locality, ILIKE, umlaut-safe), and worst-mode were each executed live before drafting; the spec cites observed cells. The plan's weights and the worst-mode demand floor will be re-checked live during implementation before shipping.
- **III. Riskiest path first** — PASS. The riskiest assumption ("do lenses actually produce different cells, or the same 3?") was proven first with live SQL; only then was the design fixed.
- **IV. Infrastructure is reproducible code** — N/A. No cloud resource changes; no `infra/` touched.
- **V. Secrets never enter git** — PASS. No credentials involved.
- **VI. Scope bounded by the clock** — PASS. Reuses the existing CTE, tool, layer and pin rendering; the only genuinely new client work (pins 4–6) was the explicit product fork the user chose. Out-of-scope list is enumerated in the spec.
- **VII. Reproducible from a script** — PASS. Built through the spec-kit cycle; validated by the `wherehouse-validate` skill's headless run + a scripted balanced-regression probe.

**Verdict: no violations, no Complexity Tracking needed.**

## Project Structure

### Documentation (this feature)

```text
specs/007-consultant-ranking-variety/
├── plan.md              # this file
├── spec.md
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── rank-sites-tool.md   # the tool's input/output contract
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
web/src/trigger/
├── scoring.ts    # rankSql gains opts {strategy, order, district, offset}; new lensOrderSql,
│                 # districtFilterSql, availableDistrictsSql; balanced path unchanged.
├── chat.ts       # rankSites input schema + execute extended; showCatchment/saveSite/focusPick
│                 # accept the same optional lens params (default balanced/best/none/page1);
│                 # SYSTEM_PROMPT gains lens/worst/district/divergence clauses.
└── layers.ts     # picks layer part carries an optional `lens` descriptor for the UI badge.

web/src/components/
├── chat.tsx      # up to 6 ranked pins: PICK_WEB_COLORS 4–6, PickMarkers, rail rows,
│                 # focusPick 1–6, lens badge from the picks layer part.
└── score.ts      # confirm rank>3 handling (colours/labels); extend if it hardcodes 3.
```

## Design (the concrete approach)

### 1. `scoring.ts` — one CTE, four axes

The `scored` CTE already exposes `dem` (composite demand 0–100), `supply_n`, `acc_n`, `gap`, `pop`, `pop_p95`, `cell`. Nothing in the CTE changes. All four axes live in `rankSql`'s tail.

**Strategy lens** = the `ORDER BY` expression (the `gap` column itself never changes — pins keep showing their true balanced gap; only the *order* differs):

| lens | ordering key (all `DESC`, then `pop DESC, cell ASC`) |
|---|---|
| `balanced` (default) | `s.gap` — **identical to today's `DETERMINISTIC_ORDER`** |
| `demand` | `1.0*s.dem + 0.20*(100−s.supply_n) + 0.30*s.acc_n` |
| `low_competition` | `0.30*s.dem + 1.0*(100−s.supply_n) + 0.20*s.acc_n` |
| `accessible` | `0.30*s.dem + 0.20*(100−s.supply_n) + 1.0*s.acc_n` |

Weighted **sums** (not the balanced product) — a *primary* factor dominant, the other two present so ordering isn't degenerate one-dimensional. Balanced stays the product `gap`, unchanged. These are **stated presets**, not a new measurement (FR-003). Exact weights confirmed live during implementation.

**Order** `worst` = the most saturated cells that still have real demand. Filter `s.pop >= 0.4 * s.pop_p95` (per-city adaptive: pop_p95 is already carried in `scored`), order `s.sup DESC, s.gap ASC, s.cell ASC`. This surfaces "packed with rivals despite a real population", not empty fields. `best` order uses the lens table above. (Worst ⇒ saturation ordering regardless of the strategy lens in v1 — combining worst with a strategy is not a requested case.)

**District** filter (optional): `AND (d.area ILIKE '%<esc>%' OR d.locality ILIKE '%<esc>%')` on the existing LEFT JOIN to `geo.districts`. `<esc>` escapes `'`, `%`, `_`, `\`. Localities resolve for ~98–100% of cells so this behaves as an inner filter on match. Umlaut-safe (verified: `ILIKE '%neukölln%'` → 69 cells).

**Paging**: `LIMIT ${limit} OFFSET ${offset}`, `offset = (page − 1) * count`. Deterministic order makes paging stable.

**Signature** (backward compatible — keep `limit` positional, add opts):
```ts
type RankStrategy = "balanced" | "demand" | "low_competition" | "accessible";
type RankOrder = "best" | "worst";
export function rankSql(
  city: CityName, categories: string[], limit = 3,
  opts: { strategy?: RankStrategy; order?: RankOrder; district?: string; offset?: number } = {},
): string
```
Existing callers `rankSql(city, cats, 1)` / `rankSql(city, cats, 3)` keep balanced/best/page-1 → byte-for-byte identical SQL → **FR-002 holds**.

New helper `availableDistrictsSql(city)` → distinct non-empty `locality` (and a few `area`) names for the no-match error (FR-006).

### 2. `chat.ts` — the tool surface

`rankSites` input schema extends `target` with all-optional, safely-defaulted fields:
```ts
strategy: enum([...]).default("balanced")
order:    enum(["best","worst"]).default("best")
district: string().optional()
count:    int().min(1).max(6).default(3)
page:     int().min(1).default(1)
```
`execute`: compute `offset=(page-1)*count`; `picks = rankSql(city, cats, count, {strategy, order, district, offset})`. If `district` set and `picks` empty → return `{ error, district, available }` from `availableDistrictsSql` (FR-006). Affinity/geojson/emitLayer as today, but the picks layer part now carries a `lens` descriptor `{strategy, order, district, page}` (see layers.ts). Model-facing return adds a top-level `lens` object so the caption can state it (FR-010/011). Pin `place` values remain the ONLY place-name source (FR-012).

`showCatchment`, `saveSite`, `focusPick` gain the same optional lens params (default balanced/best/none/page-1) so a follow-up in a lensed context stays consistent; the mandatory build sequence passes none → unchanged. `focusPick` rank max → 6.

`SYSTEM_PROMPT` gains clauses (kept in the exported prompt so the guard is runnable):
- Route language → params: "biggest market / most demand" → `demand`; "least competition / safest" → `low_competition`; "best foot traffic / walkability" → `accessible`; "where NOT to open / avoid / worst spots" → `rankSites order=worst` (distinct from `highlightExtreme`, which only marks one cell on the current surface); "best in <place>" → `district`; "more options / other options / show more" → bump `page` (or raise `count` up to 6).
- Honesty: name the active lens as a lens, never as *the* answer; frame worst as saturated/avoid; state a district answer is scoped to that district; when lensed pins fall off the choropleth's hot zone, say the pins follow the lens while the surface stays the balanced opportunity.

### 3. `layers.ts` + `chat.tsx` — up to 6 pins + the lens badge

`layers.ts`: add an optional `lens?: { strategy; order; district?; page }` to the picks `MapData`/emit path (small, model never sees it). Keep the picks `label` prefix `top N for <cat> in <city>` so the client's `^top \d+ for (.+) in (.+)$` city/category recovery is untouched.

`chat.tsx`: extend `PICK_WEB_COLORS` to 6 distinct hues; `PickMarkers` and the spider-web overlay already key on `rank`, so they scale once colours exist; the "Top picks" rail renders up to 6 rows; a small badge beside the rail header shows the lens (`by demand` / `avoid — saturated` / `in Neukölln` / `options 4–6`) read from the picks layer part. `focusPick` client handler accepts 1–6. Verify `score.ts` doesn't hardcode 3.

## Complexity Tracking

No constitution violations; table intentionally omitted.
