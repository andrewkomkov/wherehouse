# Quickstart — validating Consultant-Grade Ranking Variety

Prerequisites: `.env` loaded; ClickHouse reachable (`./infra/check-env.sh`). Live SQL uses `curl --user "default:$CLICKHOUSE_PASSWORD" "$CLICKHOUSE_URL/"`.

## 1. Balanced regression — the default must not move (FR-002, SC-002)

Run the *current* `rankSql(berlin, [bakery], 3)` and the *new* default call; the three `h3`/`gap` rows MUST be identical. Expected top-3 (2026-07-20): `881f18b021fffff` gap 100, `881f1d4d81fffff` gap 100, `881f18b563fffff` gap 95.8 (Tempelhof, Marzahn, Treptow).

## 2. Lens variety — the "same 3" is gone (SC-001)

Rank Berlin/bakery under each lens; confirm `demand`, `low_competition`, `worst` each surface a top cell absent from balanced:
- `demand` / `worst` top cells land in Charlottenburg-Wilmersdorf (high pop, gap ~0, 60+ rivals) — NOT in the balanced set.

## 3. District scope (SC-003)

`rankSites(berlin, bakery, district="Neukölln")` ⇒ every pin's `place` contains Neukölln.
`district="Kreuzberg"` ⇒ pins inside Friedrichshain-Kreuzberg (matched via the `area` tier).
`district="Atlantis"` ⇒ `{ error, available: [...] }` naming real districts, no map drawn.

## 4. Paging + six pins (SC-004, FR-008)

`rankSites(berlin, bakery, count=6)` ⇒ 6 ranked pins on the map, ranks 1–6, each with its own score/place.
Then "more options" (`page=2`) ⇒ the next distinct cells, none repeated from page 1.

## 5. Honesty (SC-005, SC-006) — headless `chat.agent()` run

Via the `wherehouse-validate` skill, drive a session:
1. "where should I open a bakery in Berlin" → balanced pins + caption.
2. "show me the biggest markets even if competitive" → pins move; caption names the *demand lens* and notes the pins follow the lens while the surface stays the balanced opportunity.
3. "where should I avoid" → saturated pins; caption frames them as already-packed, never "bad".
4. "best spot in Neukölln" → scoped pins; caption says it's limited to Neukölln.
5. Assert: every place name in the prose appears in a `rankSites` payload (day-3 guard, SC-006).

## 6. Determinism (FR-009)

Repeat any single (strategy, order, district, page) call twice ⇒ identical rows.

## Done when

- Steps 1–6 pass live; `pnpm build`/typecheck clean; the balanced demo answer is unchanged; the four new intents each produce a distinct, honestly-labelled answer.
