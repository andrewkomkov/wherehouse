# Phase 1 Data Model — Consultant-Grade Ranking Variety

No new tables, columns, or MVs. This documents the in-flight shapes the feature adds.

## Ranking request (tool input → SQL opts)

| field | type | default | meaning |
|---|---|---|---|
| `city` | enum(berlin, amsterdam, belgrade) | — | required |
| `category` | trade / group string | — | required |
| `strategy` | `balanced` \| `demand` \| `low_competition` \| `accessible` | `balanced` | ORDER-BY lens over the scored cells |
| `order` | `best` \| `worst` | `best` | `worst` ⇒ saturation-among-demand ordering |
| `district` | string | (none) | name-contains filter on either `geo.districts` tier |
| `count` | int 1–6 | 3 | pins on screen |
| `page` | int ≥ 1 | 1 | `offset = (page-1)*count` |

Only `city` + `category` are required; all defaults reproduce today's exact call.

## Scored candidate cell (unchanged source of truth)

Produced by `candidateCells()` → `scored` CTE. Fields the ranking reads: `cell`, `pop`, `sup`, `dem` (0–100 composite demand), `supply_n`, `acc_n`, `gap` (balanced product), `pop_p95`, `has_acc`, `acc_pop`, plus `cap_area`/`addr_cnt` for the pick card. **This feature adds nothing here and changes no value.**

Ordering keys derived at rank time (not stored):
- balanced: `gap DESC, pop DESC, cell ASC`
- demand: `1.0·dem + 0.20·(100−supply_n) + 0.30·acc_n DESC, pop DESC, cell ASC`
- low_competition: `0.30·dem + 1.0·(100−supply_n) + 0.20·acc_n DESC, pop DESC, cell ASC`
- accessible: `0.30·dem + 0.20·(100−supply_n) + 1.0·acc_n DESC, pop DESC, cell ASC`
- worst (any lens): `sup DESC, gap ASC, cell ASC` with `WHERE pop >= 0.4·pop_p95`

## District (read-only filter)

`geo.districts(city, h3_8, area, locality)`. Two name tiers; `area` is the finer one (may be `''`), `locality` the broader (resolves ~98–100%). Used only to filter cells by name via `area/locality ILIKE '%…%'`; never scored.

## Pin (ranked pick, model + map)

Per pin, unchanged fidelity plus lens context:
- map GeoJSON feature properties: `rank` (1–6), `gap`, `dem`, `acc`, `pop`, `sup`, optional `capM2`/`addr`, `h3`, `place` (only from geometry), optional `fit`/`topNeighbours`.
- model-facing summary: `rank`, `place`, `gap`, `population`, `competitorsNearby`, optional built/address/complementary context — **all tool-derived**.

## Lens descriptor (new, map-only)

Carried on the picks layer part, never shown to the model:
```
lens: { strategy: RankStrategy; order: RankOrder; district?: string; page: number }
```
Drives the UI badge (`by demand`, `avoid — saturated`, `in Neukölln`, `options 4–6`). The picks `label` stays `top N for <cat> in <city>` for city/category recovery.

## Invariants

- **INV-1**: `strategy=balanced, order=best, page=1` ⇒ SQL identical to today (FR-002).
- **INV-2**: every ordering ends in a `cell` tiebreak ⇒ deterministic per (strategy, order, district, page) (FR-009).
- **INV-3**: `place` originates only from `geo.districts` point-in-polygon geometry; the district *filter* never becomes a *name source* (FR-012).
- **INV-4**: pins ≤ 6 (FR-008); a district/page with fewer candidates returns fewer, never padded.
