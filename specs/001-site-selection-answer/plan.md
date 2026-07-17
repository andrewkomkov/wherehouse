# Implementation Plan: The site-selection answer flow

**Branch**: `001-site-selection-answer` | **Date**: 2026-07-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-site-selection-answer/spec.md`

## Summary

Replace the day-2 scaffold's single `showSavedSites` tool with three real tools —
`findCompetitors`, `scoreArea`, `rankSites` — each owning one map layer and one ClickHouse
query. The GAP score is computed at H3 res 8 with ring-based supply and percentile-scaled
terms (no invented constants). Layers are emitted through **one shared writer that measures
the serialized payload and switches to a by-reference handle above 256 KiB**; the browser
resolves handles by reading GeoJSON straight out of ClickHouse.

The approach is fully de-risked: every mechanism below was executed against the live service
during Phase 0 ([research.md](./research.md)), including the complete handle round-trip with
the real 549 KiB choropleth.

## Technical Context

**Language/Version**: TypeScript 5, Node 26

**Primary Dependencies**: `@trigger.dev/sdk` 4.5 (`chat.agent()`), `ai` 5 + `@ai-sdk/anthropic` 2,
`@clickhouse/client` 1, Next 15 / React 19, MapLibre GL 5, `@protomaps/basemaps` 5

**Storage**: ClickHouse Cloud 26.4 (`geo.places` 211,818 rows; `geo.population` 475,535 rows;
`web.layers` **new** — the by-reference layer store, TTL 1 h)

**Testing**: Manual quickstart against the live service ([quickstart.md](./quickstart.md)) plus
`pnpm typecheck`. No unit-test harness exists and none is added — constitution VI; the exit
gate is behavioural and observed in the browser.

**Target Platform**: Browser (demo) + Trigger.dev cloud tasks

**Project Type**: Web application — Next.js frontend + Trigger.dev task backend

**Performance Goals**: First layer < 3 s, complete answer < 15 s (SC-002). Measured
ClickHouse work: 430 ms + 700 ms + 700 ms, handle round-trip 1.3 s ⇒ < 3 s total, the rest is
LLM latency.

**Constraints**: **~1 MiB hard cap per stream record**, unraisable. No `GeoJSON` format, no
MVT (needs 26.6; Cloud is 26.4 and trails ~2 releases — assume it never arrives). H3 only via
MATERIALIZED columns. The entire H3 function family is lat-first.

**Scale/Scope**: 3 cities, ~2.3k candidate cells per city, 3 tools, 3 layers, 1 new table.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1 design.*

| Principle | Status | Evidence |
|---|---|---|
| **I — visual, never prose** | ✅ PASS | Three `data-map` layers are the output; system prompt caps prose at two sentences (SC-006). Tools return counts, which the model cannot turn into a wall of text. |
| **II — verified, not documented** | ✅ PASS | Phase 0 executed every mechanism live: handle round-trip byte-identical, CORS with `Origin`, grant wildcard by canary, GeoJSON validated by parsing, determinism by triple-run hash. Two new silent traps found by executing (`h3ToGeo`, `h3ToGeoBoundary` lat-first) and one ADR claim corrected (CORS needs `Origin` to echo). |
| **III — riskiest path first** | ✅ PASS | The handle path was the one unproven mechanism and was proven **before any of it was designed into tasks**, with the real payload rather than a toy. FR-014 then keeps it on the demo's happy path so it cannot rot. |
| **IV — infrastructure is code** | ✅ PASS | One new table, as `db/clickhouse/004_layers_schema.sql`, applied by a script. **Zero access DDL** (R2) — which is also the trap-#4 mitigation. No console clicks. |
| **V — secrets never enter git** | ✅ PASS | The `site` token reaches the browser via `NEXT_PUBLIC_*` from the gitignored `.env`; `.env.example` carries the contract only. gitleaks gate untouched. See R8. |
| **VI — bounded by the clock** | ✅ PASS | Spec cuts seven things. This plan adds no library, no test framework, no abstraction layer. The score stays a one-breath formula (FR-008) rather than a model. |

**Gate result: PASS, no violations.** Complexity Tracking is therefore omitted — nothing to
justify.

## Project Structure

### Documentation (this feature)

```text
specs/001-site-selection-answer/
├── plan.md              # This file
├── spec.md              # /speckit-specify output
├── research.md          # Phase 0 — all live-verified
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1 — the exit-gate script
├── contracts/
│   ├── tools.md         # agent tool contracts (model-facing)
│   └── layer-parts.md   # data-map part contract (UI-facing) + handle resolution
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
db/clickhouse/
└── 004_layers_schema.sql        # NEW — web.layers, TTL 1h, no access DDL

infra/
└── load-layers.sh               # NEW — applies 004 (constitution IV: infra is code)

web/src/
├── trigger/
│   ├── chat.ts                  # REWRITTEN — showSavedSites (FR-020) → 3 real tools
│   ├── scoring.ts               # NEW — the GAP SQL, one definition, both tools share it
│   └── layers.ts                # NEW — emitLayer(): measures bytes, inline-or-handle
└── components/
    ├── chat.tsx                 # REWRITTEN — 3 layers, handle resolution, ADR-001 gate box out
    └── attribution.tsx          # NEW — Kontur CC BY (FR-017, licence obligation)
```

**Structure Decision**: The existing Next-plus-Trigger layout is kept as-is. The only new
concepts are two small modules under `web/src/trigger/` — `scoring.ts` so the GAP formula has
exactly one definition (it is used by both `scoreArea` and `rankSites`, and two copies would
drift), and `layers.ts` so the byte-measuring inline-vs-handle decision cannot be forgotten at
one call site (FR-012). No `models/services/` scaffolding: this is three tools and one table,
and a layered architecture over it would be paperwork.

## Phase 1 design decisions

### The layer writer is the load-bearing abstraction

Every layer goes through one function. It serializes, **measures the actual bytes**, and picks
the path (FR-012 — never a row-count heuristic, because a category with long names breaks any
row guess):

```
emitLayer(id, label, geojson):
  body = JSON.stringify(geojson)
  if body.length <= 256 KiB  → chat.response.write({ type:"data-map", id, data:{ inline } })
  else                       → INSERT into web.layers; write({ …, data:{ handle } })
  return { rowCount }                       # ADR-001: the model sees only this
```

Measured outcome: competitors 175 KiB → inline; choropleth 549 KiB → handle. The budget is
256 KiB, a **4× margin** under the 1 MiB cap for envelope overhead and concurrent parts.

### One part id per layer

`data-map` ids are `competitors`, `opportunity`, `picks` — not a single shared `map`. ADR-001's
in-place merge (proven day 2) then makes each layer independently rewritable, which is what
lets them arrive as their work completes (FR-002) instead of in one batch.

### Determinism and the tiebreak

`ORDER BY gap DESC, pop DESC, cell ASC` — a total order, verified stable across three runs
(R7). Needed because the p95 clamp legitimately ties cells at 100.0.

## Phase 2 preview *(not built here — /speckit-tasks owns this)*

Rough order, dependency-first: `web.layers` schema + loader → `scoring.ts` → `layers.ts` →
the three tools → client layer rendering + handle resolution → attribution → delete
`showSavedSites` → run the quickstart exit gate.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A top-3 cell is a park/cemetery (no land-use model) | medium | Not firing on the measured Berlin top-3. If observed: a population floor in the `WHERE`, not a score change. Cheap, one line. |
| DeepSeek balance is **$4.87** | medium | Enough for day 3's iteration, not for a week of demos. Watch it; `check-env.sh` reports it. Falls back to real Anthropic by dropping `ANTHROPIC_BASE_URL`. |
| The model narrates coordinates in prose anyway | low | System prompt forbids it; tools return only counts, so it has no geometry to narrate (ADR-001). |
| `web.layers` grows through the demo | low | `TTL created_at + INTERVAL 1 HOUR`, verified accepted on `CREATE` (FR-015). |
</content>
