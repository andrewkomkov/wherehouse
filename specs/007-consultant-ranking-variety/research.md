# Phase 0 Research — Consultant-Grade Ranking Variety

All decisions below were driven by live probes against ClickHouse Cloud 26.4 on 2026-07-20 (constitution II). No NEEDS CLARIFICATION remained after the spec.

## Decision 1 — Variety is a query concern, not a data concern

**Decision**: Surface variety by reordering/filtering the existing `scored` CTE; add no data.

**Rationale**: Live Berlin/bakery probe showed the same scored cells produce materially different top sets under different orderings:
- balanced top-3: Tempelhof-Schöneberg, Marzahn-Hellersdorf, Treptow-Köpenick.
- by population: Charlottenburg-Wilmersdorf (8,061 / 7,966 residents, gap 0).
- worst (saturation): Charlottenburg cells with 62–64 rivals.

So the "same three pins" is purely an artefact of always asking for the global balanced top-3. Reordering the cells we already score is sufficient.

**Alternatives considered**: a separate "diversity" table or clustering to force spread — rejected (new data, new failure surface, no rubric gain, violates VI).

## Decision 2 — Strategy = ORDER-BY presets, gap column unchanged

**Decision**: Each non-balanced lens is a weighted **sum** of the three already-normalized factors used only in `ORDER BY`; the `gap` shown on each pin stays the balanced product. Weights: primary 1.0, secondary two at 0.2–0.3.

**Rationale**: Keeps balanced byte-for-byte (FR-002) and keeps every lens honest — it is a stated re-weighting of real factors, never a new score (FR-003, constitution II). A dominant-primary-plus-minor-others sum avoids degenerate one-axis ties while still clearly favouring the named factor.

**Alternatives considered**: (a) pure single-axis ordering — simpler but degenerate on ties and reads as "sorted by population", less consultant-like; (b) a unified parametrized product with balanced as a special case — a product is not a special case of a weighted sum, so this would have *moved* the balanced answer. Rejected.

## Decision 3 — Worst = saturation among real demand

**Decision**: `worst` filters to cells with `pop >= 0.4 * pop_p95` (per-city adaptive, `pop_p95` already in `scored`) and orders `sup DESC, gap ASC, cell ASC`.

**Rationale**: Without the demand floor, "lowest gap" surfaces empty fields (low gap because low demand), which is not the "avoid — already packed" answer a consultant means. The floor is a fraction of the city's own 95th-percentile population, so it travels across Berlin/Amsterdam/Belgrade without a hardcoded headcount. Ordering by `sup` directly makes "most rivals nearby" the explicit story. The exact floor fraction is re-confirmed live during implementation.

**Alternatives considered**: a fixed `pop > 3000` floor — Berlin-tuned, wrong for smaller Amsterdam/Belgrade cells. Rejected.

## Decision 4 — District matching on both name tiers, ILIKE

**Decision**: `AND (d.area ILIKE '%<esc>%' OR d.locality ILIKE '%<esc>%')`, escaping `'`, `%`, `_`, `\`. No match ⇒ tool returns available district names, never an empty map.

**Rationale**: Live probe: `geo.districts` stores two tiers. "Kreuzberg" exists **only** as an `area` inside locality "Friedrichshain-Kreuzberg", so matching one tier alone would miss common inputs. ILIKE is case-insensitive and matched the umlaut form (`ILIKE '%neukölln%'` → 69 cells) as well as the capitalised input. Belgrade is mostly locality-only (`area` ~3.9%) — a locality match there is a normal success.

**Alternatives considered**: a geocoder / fuzzy / LLM resolver — out of scope (FR-013), adds a hallucination surface, no rubric gain.

**Note on the earlier empty ILIKE result**: the first `ILIKE '%kreuzberg%'` probe returned zero rows immediately after the service woke from idle; a warm re-run returned the expected rows. This was the documented 15-minute idle-wake transient (CLAUDE.md), not an ILIKE limitation.

## Decision 5 — Paging via OFFSET, ceiling 6 pins

**Decision**: `LIMIT count OFFSET (page-1)*count`, `count` capped 1–6. "More options" bumps `page`; "show me several" raises `count`.

**Rationale**: The deterministic total order (with the `cell` tiebreak) makes OFFSET paging stable — the same page returns the same cells (FR-009). Six was the user's explicit choice over swap-3, so up to six pins render at once for side-by-side comparison (FR-008).

**Alternatives considered**: keep 3 pins and swap them per page — cheaper client-side but the user chose the richer compare. Recorded and rejected per the user's answer.

## Decision 6 — Keep the picks label stable; carry the lens out-of-band

**Decision**: The picks layer keeps its `top N for <cat> in <city>` label (the client parses city/category from it); the active lens travels as a separate small `lens` descriptor on the picks layer part.

**Rationale**: The client already recovers `(category, city)` from `picks.label` via `^top \d+ for (.+) in (.+)$`. Encoding lens text into the label would break that recovery. A dedicated field badges the lens in the UI without disturbing the regex. The model never sees this descriptor (ADR-001).
