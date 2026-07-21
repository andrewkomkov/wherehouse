# Tasks: Consultant-Grade Ranking Variety

**Feature**: 007-consultant-ranking-variety | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

Server: `web/src/trigger/scoring.ts`, `web/src/trigger/chat.ts`, `web/src/trigger/layers.ts`. Client: `web/src/components/chat.tsx`, `web/src/components/score.ts`. No infra, no DB changes.

Most tasks touch one of three shared files (`scoring.ts`, `chat.ts`, `chat.tsx`), so `[P]` is rare — same-file edits are sequential. Live SQL uses `curl --user "default:$CLICKHOUSE_PASSWORD" "$CLICKHOUSE_URL/"` after `set -a && source .env`.

## Phase 1: Setup

- [x] T001 Warm the ClickHouse service and capture the current balanced baseline as a regression fixture: run today's `rankSql(berlin,[bakery],3)` and save the three `h3`/`gap` rows into `specs/007-consultant-ranking-variety/baseline.txt` (expected `881f18b021fffff`/100, `881f1d4d81fffff`/100, `881f18b563fffff`/95.8). This is the FR-002 oracle for T020.

## Phase 2: Foundational (blocking — all stories build on this)

- [x] T002 In `web/src/trigger/scoring.ts`, change `rankSql(city, categories, limit=3)` to `rankSql(city, categories, limit=3, opts: { strategy?; order?; district?; offset? } = {})`; define `RankStrategy`/`RankOrder` types (export them). For the default opts (`strategy=balanced, order=best, district none, offset 0`) the emitted SQL MUST be byte-for-byte today's (keep `DETERMINISTIC_ORDER`, add `OFFSET 0` only when offset>0). Leave the ORDER-BY/WHERE branch points as `balanced`/`best`/no-district stubs to be filled per story.
- [x] T003 In `web/src/trigger/scoring.ts` update the two existing callers `showCatchment`→`rankSql(c.city,cats,1)` and `saveSite`→`rankSql(c.city,cats,3)` in `web/src/trigger/chat.ts` to compile unchanged against the new signature (no behavioural change); typecheck to confirm the balanced path still resolves.
- [x] T004 In `web/src/trigger/layers.ts`, add an optional `lens?: { strategy: string; order: string; district?: string; page: number }` to the picks layer emission path (map-only, never returned to the model); keep the picks `label` format `top N for <cat> in <city>` intact so the client's `^top \d+ for (.+) in (.+)$` recovery is unaffected.

**Checkpoint**: `pnpm --dir web build` (or typecheck) is green and the balanced demo answer is unchanged before any story lands.

## Phase 3: User Story 1 — A different strategic lens (P1) 🎯 MVP

**Goal**: same scored cells, re-ranked under a named strategy; the pins move and the caption names the lens.
**Independent test**: ask balanced, then "biggest market" — pins move to different cells; "back to balanced" restores the exact original three.

- [x] T005 [US1] In `web/src/trigger/scoring.ts`, add the strategy ORDER-BY presets (weighted sums of `s.dem`, `100−s.supply_n`, `s.acc_n`; balanced stays `s.gap`), each ending `, s.pop DESC, s.cell ASC`. Then LIVE-VERIFY the exact weights: run demand/low_competition/accessible for berlin/bakery and confirm each top cell differs from balanced and reads sensibly; tune the 0.2–0.3 minor weights if a lens degenerates. Record the confirmed weights in a code comment.
- [x] T006 [US1] In `web/src/trigger/chat.ts`, extend `rankSites` input schema with `strategy` (enum, default `balanced`); pass it into `rankSql`; add a top-level `lens:{strategy,order,district,page}` to the model-facing return and to the picks layer part (via T004). Keep affinity/geojson/emitLayer paths intact.
- [x] T007 [US1] In `web/src/trigger/chat.ts` `SYSTEM_PROMPT`, add routing ("biggest market/most demand"→demand, "least competition/safest"→low_competition, "best foot traffic/walkability"→accessible) and the honesty clauses: name the active lens AS a lens (never "the" answer), and when lensed pins fall off the choropleth hot zone say the pins follow the lens while the surface stays the balanced opportunity (FR-010/011).
- [x] T008 [US1] Verify live per quickstart §2: `demand`, `low_competition` top cells for berlin/bakery are absent from the balanced set (SC-001); balanced still returns the T001 baseline.

**Checkpoint**: US1 works end-to-end and is independently demoable.

## Phase 4: User Story 2 — Where NOT to open (P1)

**Goal**: pin the most saturated cells that still have demand, framed as "avoid".
**Independent test**: "where should I avoid a bakery in Berlin" → high-rival, high-pop pins framed as saturated.

- [x] T009 [US2] In `web/src/trigger/scoring.ts`, add the `order=worst` branch to `rankSql`: `WHERE ... AND s.pop >= 0.4 * s.pop_p95` plus `ORDER BY s.sup DESC, s.gap ASC, s.cell ASC`. LIVE-VERIFY the 0.4 demand-floor fraction across berlin/amsterdam/belgrade (surfaces genuinely populated, rival-dense cells, not empty fields); adjust the fraction if a city degenerates and record it in a comment.
- [x] T010 [US2] In `web/src/trigger/chat.ts`, add `order` (enum best|worst, default best) to `rankSites`, pass through to `rankSql`, include in the `lens` descriptor.
- [x] T011 [US2] In `SYSTEM_PROMPT`, route "where NOT to open / avoid / worst / most saturated spots" → `rankSites order=worst`, framed as already-saturated/avoid (never "bad places"); state explicitly this is distinct from `highlightExtreme` (which only marks one cell on the current surface).
- [x] T012 [US2] Verify live per quickstart: worst berlin/bakery surfaces Charlottenburg cells with 60+ rivals; confirm the empty-worst edge (a near-rival-free trade) degrades honestly.

**Checkpoint**: US2 works end-to-end; US1 still green.

## Phase 5: User Story 3 — Best in one district (P2)

**Goal**: rank only inside a named district; no-match returns real district names, never an empty map.
**Independent test**: "best bakery in Neukölln" → all pins inside Neukölln; "in Atlantis" → error listing districts.

- [x] T013 [US3] In `web/src/trigger/scoring.ts`, add the optional district filter to `rankSql` (`AND (d.area ILIKE '%<esc>%' OR d.locality ILIKE '%<esc>%')`, escaping `'`,`%`,`_`,`\`), and add `availableDistrictsSql(city)` returning distinct non-empty locality names (plus a few areas). LIVE-VERIFY: Neukölln matches, Kreuzberg matches via the `area` tier, umlauts hold.
- [x] T014 [US3] In `web/src/trigger/chat.ts`, add optional `district` to `rankSites`; pass through; when `district` is set and `picks` is empty, return `{ error:"no cells in that district", district, available: <from availableDistrictsSql> }` (FR-006); include `district` in the `lens` descriptor.
- [x] T015 [US3] In `SYSTEM_PROMPT`, route "best <trade> in <place>" → `district`; require the caption to state the answer is scoped to that district; reaffirm the place-name guard — the district FILTER never becomes a place-name source, names still come only from tool `place` values (FR-012).
- [x] T016 [US3] Verify live per quickstart §3: pins-in-district for all three cities (or locality-only for Belgrade), Kreuzberg-via-area, and the no-match error path.

**Checkpoint**: US3 works end-to-end; US1/US2 still green.

## Phase 6: User Story 4 — More options / six pins (P2)

**Goal**: page beyond the first picks, up to six concurrent ranked pins.
**Independent test**: "show me more" → next distinct cells; up to 6 pins, each with its own rank/score/place.

- [x] T017 [US4] In `web/src/trigger/chat.ts`, add `count` (int 1–6, default 3) and `page` (int ≥1, default 1) to `rankSites`; compute `offset=(page-1)*count`; pass `offset` into `rankSql`; include `page` in the `lens` descriptor; raise `focusPick` rank max to 6.
- [x] T018 [US4] In `web/src/components/chat.tsx`, extend to up to 6 pins: add ranks 4–6 to `PICK_WEB_COLORS`, confirm `PickMarkers`/spider-web overlay and the "Top picks" rail render ranks 1–6, and accept `focusPick` 1–6. Check `web/src/components/score.ts` for any hardcoded-3 and extend if present.
- [x] T019 [US4] In `web/src/components/chat.tsx`, read the `lens` descriptor off the picks layer part and render a small badge beside the rail header (`by demand` / `avoid — saturated` / `in <district>` / `options 4–6`); default (balanced/best/none/page1) shows no badge.
- [x] T020 [US4] In `SYSTEM_PROMPT`, route "more options / other options / show more" → bump `page` (or raise `count` up to 6); when paging is exhausted, say there are no further distinct options rather than repeating cells (Story 4 AS3).
- [x] T021 [US4] Verify live + in the browser per quickstart §4: `count=6` shows 6 distinct pins; `page=2` shows new cells not on page 1; a small district returns fewer than 6 without padding.

**Checkpoint**: all four stories work end-to-end.

## Phase 7: Polish & Cross-Cutting

- [x] T022 Balanced regression (FR-002/SC-002): re-run the default `rankSites(berlin,bakery)` path and diff against `baseline.txt` from T001 — must be identical.
- [x] T023 `pnpm --dir web build` + typecheck clean; run a headless `chat.agent()` honesty pass via the `wherehouse-validate` skill covering quickstart §5 (lens/worst/district captions honest; every prose place name is in a `rankSites` payload — SC-005/SC-006).
- [x] T024 [P] Update `CLAUDE.md` "Where we are" + the tool surface note and `docs/` if the new `rankSites` parameters warrant a line; keep it terse.

## Dependencies & MVP

- **Phase 1 → Phase 2 → Stories**. US1–US4 all depend on Phase 2 (the `rankSql` opts signature + lens plumbing). Given shared files, do the stories in order.
- **US1 is the MVP**: it alone retires the "same three pins" complaint. US2 (worst) is also P1 and small. US3/US4 are P2 enhancements.
- Within a story, the scoring change precedes the tool change precedes the prompt change precedes the live verify.

## Parallel opportunities

Limited by shared files. Genuinely parallel: T024 (docs) with any late verify; the per-story LIVE-VERIFY tasks (T008/T012/T016/T021) are independent read-only probes once their story's code lands. Client work (T018/T019, `chat.tsx`) can proceed in parallel with server prompt tweaks (different files) once T017 lands the schema.

## Independent test criteria

- US1: pins move between balanced and a lens; balanced restores baseline.
- US2: worst pins are saturated-but-populated, framed as avoid.
- US3: district pins all inside the district; no-match lists real districts.
- US4: "more" yields new cells; up to six pins, each full-fidelity.
