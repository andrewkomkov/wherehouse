---
description: "Task list for the site-selection answer flow"
---

# Tasks: The site-selection answer flow

**Input**: Design documents from `specs/001-site-selection-answer/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: **No test tasks.** The spec does not request them, no unit-test harness exists, and
day 3 does not add one (constitution VI). The exit gate is behavioural and observed in a
browser — [quickstart.md](./quickstart.md) is the validation, and it is a real task (T017),
not an afterthought.

**Organization**: By user story, so each is independently deliverable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different file, no dependency on incomplete work
- **[Story]**: US1 / US2 / US3, mapping to spec.md
- Every task names its exact file path

**Phase 0 is already done.** Every mechanism these tasks rely on was executed live during
planning ([research.md](./research.md)): the handle round-trip byte-identical at 549 KiB, the
`web.*` grant wildcard, CORS-with-`Origin`, GeoJSON validated by parsing, ranking determinism
by triple-run hash. These tasks are assembly, not discovery.

---

## Phase 1: Setup

**Purpose**: the browser needs to reach ClickHouse as `site`.

- [X] T001 Add the frontend ClickHouse contract to `.env.example` and set the real values in
      `.env`: `NEXT_PUBLIC_CLICKHOUSE_URL`, `NEXT_PUBLIC_CLICKHOUSE_SITE_USER`,
      `NEXT_PUBLIC_CLICKHOUSE_SITE_PASSWORD`. The `site` password is a **public token by
      design** (ADR-003, R8) — it ships in the client bundle and that is safe, because
      `readonly=1` is not escapable. It is **still a credential**: real values go in the
      gitignored `.env` only, `.env.example` gets placeholders. Do not weaken the gitleaks
      gate (constitution V).

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the layer store, the one scoring definition, and the one layer writer.

**⚠️ CRITICAL**: no user story can begin until this phase is complete. T005 in particular is
what stands between the demo and `ChatChunkTooLargeError`.

- [X] T002 Create `db/clickhouse/004_layers_schema.sql` — `web.layers (id String, body String,
      created_at DateTime DEFAULT now())`, `ENGINE = MergeTree ORDER BY id`,
      `TTL created_at + INTERVAL 1 HOUR` (FR-015). Table goes in `web` **deliberately**:
      `GRANT SELECT ON web.*` is a wildcard that already covers it, so this needs **zero
      access DDL** — verified by canary (R2). Comment that in the file: it is the trap-#4
      mitigation, and the next person will be tempted to "fix permissions" with a `GRANT`.
- [X] T003 Create `infra/load-layers.sh` applying T002, idempotent, verifying the table exists
      afterwards (constitution IV — a console click is a bug). Follow the shape of the
      existing `infra/*.sh`; `shellcheck --severity=warning` must stay clean (CI gates on it).
- [X] T004 [P] Create `web/src/trigger/scoring.ts` — the GAP query, **defined exactly once**
      (both `scoreArea` and `rankSites` use it; two copies would drift). Includes the city
      registry: bbox + population country for `berlin`(DE) / `amsterdam`(NL) / `belgrade`(RS).
      Per [data-model.md](./data-model.md): ring supply via `h3kRing(h3_8, 1)` (FR-006), p95
      scaling on both terms with `greatest(p95(sup), 1)` guarding the divide (FR-007/FR-010),
      order `gap DESC, pop DESC, cell ASC` (FR-004).
      ⚠️ **The bbox filter is where the new trap lives**: `h3ToGeo(h3).1` is **LAT**, `.2` is
      **LON**. Swapped ⇒ zero rows, **no error**. Reference SQL is in
      [quickstart.md](./quickstart.md) and it is verified — copy it, don't re-derive it.
- [X] T005 [P] Create `web/src/trigger/layers.ts` — `emitLayer(id, label, geojson)`:
      serialize, **measure `body.length`**, `≤ 256 KiB` → inline part, `>` → `INSERT` into
      `web.layers` and emit a handle part; return `{ rowCount }` (ADR-001 — the model never
      sees geometry). The decision is on **measured bytes, never a row count** (FR-012) —
      a category with long names breaks any row-count guess. Contract:
      [contracts/layer-parts.md](./contracts/layer-parts.md).
- [X] T006 Rewrite the types in `web/src/trigger/chat.ts` and **delete `showSavedSites`**
      (FR-020) — it was built to exercise the ADR-001 gate, the gate passed on day 2, and its
      deliberate double-write is a defect in a real tool. Add `LayerId` and the `MapData`
      inline|handle union. ⚠️ Keep the type **bare** (`type WhereHouseDataTypes = { map: MapData }`)
      — do not intersect with `UIDataTypes` as the Trigger.dev docs do; it silently destroys
      all client-side narrowing.

**Checkpoint**: layer store live, scoring defined once, every layer forced through the
byte-measuring writer.

---

## Phase 3: User Story 1 — The opportunity map (Priority: P1) 🎯 MVP

**Goal**: "where should I open a bakery in Berlin?" → three layers on one live map.

**Independent Test**: ask it; three layers arrive, each from a real ClickHouse query, no run
failure. This is the day-3 exit gate and the demo video's first shot.

**Note on ordering**: T007–T010 all edit `chat.ts`, so they are **not** parallel with each
other. That is a real conflict, not caution.

- [X] T007 [US1] Implement `findCompetitors` in `web/src/trigger/chat.ts` — competitor dots,
      emits layer `competitors` via `emitLayer`. Returns `{ rowCount, bbox }`.
      *Measured: 1,460 rows · 430 ms · 175 KiB ⇒ inline.*
- [X] T008 [US1] Implement `scoreArea` in `web/src/trigger/chat.ts` — H3 res-8 GAP choropleth
      from `scoring.ts`, emits layer `opportunity`. Returns `{ cellCount, topGap, medianGap }`.
      *Measured: 2,260 cells · 700 ms · **549 KiB ⇒ handle path**, every time (FR-014).*
- [X] T009 [US1] Implement `rankSites` in `web/src/trigger/chat.ts` — top 3 from `scoring.ts`,
      emits layer `picks`. Each pick carries `{ rank, gap, pop, sup }` so a sceptic can
      recompute the ranking by hand (FR-003).
- [X] T010 [US1] Wire the three tools into the agent config in `web/src/trigger/chat.ts`.
      ⚠️ Tools MUST be declared on the agent config (`tools:`), not only passed to
      `streamText` — otherwise `toModelOutput` runs on turn 1 and is **silently skipped**
      afterwards (ADR-001). System prompt: the map is the answer, at most two sentences, never
      narrate coordinates (constitution I, SC-006).
- [X] T011 [US1] Render the three layers in `web/src/components/chat.tsx`: `opportunity` fill
      ramped on `properties.gap` (bottom), `competitors` circles (middle), `picks` ranked
      symbols (top). Resolve `handle` parts by fetching from ClickHouse directly — the exact
      GET is in [contracts/layer-parts.md](./contracts/layer-parts.md), verified at 550 ms.
      Show `label`/`rowCount` immediately, paint when the fetch lands. Remove the day-2
      "ADR-001 gate" debug box — the gate has passed.
- [X] T012 [P] [US1] Create `web/src/components/attribution.tsx` — Kontur CC BY 4.0, visible on
      every view showing the map (FR-017: a **licence obligation**, not a courtesy), and state
      the population is a **2023-11-01 snapshot** so the UI never implies live demand (FR-018).
- [X] T013 [US1] Run the exit gate in [quickstart.md](./quickstart.md): three layers, arriving
      progressively, no `ChatChunkTooLargeError`, ≤2 sentences, attribution visible, map
      survives a reload. **Hand-verify the top-3 against the reference SQL** — if the pins
      disagree with that query, the agent is wrong. Expected: Lichtenrade, Biesdorf, Mahlsdorf. **If it lands on Mitte, the demand term has regressed to a POI proxy** and the
      answer is no longer defensible — stop and fix before continuing.

**Checkpoint**: the product exists. Day 3's exit gate is met and the submission stands on
this alone.

---

## Phase 4: User Story 2 — A question wide enough to break the stream (Priority: P2)

**Goal**: *"show me every restaurant"* renders instead of killing the run.

**Independent Test**: ask for a layer above the cap; the map renders fully, the run completes.

**Note**: US1 already carries most of this — `emitLayer` (T005) is shared and the choropleth
already exercises the handle path on every question. What remains is letting a user *ask* for
a wide layer, and proving the cap is genuinely dead.

- [X] T014 [US2] Support category groups in `web/src/trigger/chat.ts` (e.g. "restaurants",
      "food & drink" → a category set), so a wide layer is reachable from a normal question.
- [~] T015 [US2] Verify SC-003 against the widest layer in the data.
      **Done, partially — say what was actually run.** Verified live: "all food and drink" =
      6,664 features / **781 KiB**, over budget, handle path, renders, run completes. The
      **14.9 MiB** every-Berlin-POI case was NOT run through the UI: no question reaches it,
      because "everything" is not a trade and no category group covers it.
      The risk is nonetheless retired by construction rather than by that test: over budget,
      the payload never touches the stream — only the handle does — so stream size is constant
      regardless of layer size. 14.9 MiB would exercise the ClickHouse INSERT and the browser
      fetch, not the cap. Left open deliberately rather than marked done.

**Checkpoint**: no question a user can ask can kill the run.

---

## Phase 5: User Story 3 — Another city, another trade (Priority: P3)

**Goal**: pharmacy in Amsterdam, kindergarten in Belgrade, same answer shape.

**Independent Test**: ask the same question shape for a different city/category.

**Note**: the city registry lands in T004 because `scoring.ts` needs a bbox regardless — it is
one const array for three cities, and splitting it across stories would be theatre. All three
cities' data is already loaded and verified, so what actually remains here is the *honesty*
path and the proof.

- [X] T016 [US3] Handle unheld cities and categories in `web/src/trigger/chat.ts` — return
      `{ error: "unavailable", available: [...] }` and have the agent say so plainly.
      **Never render an empty map**: it reads as "nowhere is good", which is a lie (FR-005).
- [X] T017 [US3] Verify a pharmacy in Amsterdam and a kindergarten in Belgrade produce layers
      for the right city, category and population country (NL / RS).

**Checkpoint**: the answer is a system, not a Berlin hardcode.

---

## Phase 6: Polish & cross-cutting

- [X] T018 [P] Update `docs/architecture/progressive-map.md` (ADR-001): the 1 MiB section is
      no longer an open problem — record the handle path as **proven** (549 KiB round-trip,
      byte-identical, 770 ms in / 550 ms out) and mark the seven-wave choreography's status
      honestly against what actually shipped.
- [X] T019 [P] Update `docs/PLAN.md`: mark day 3 done with its measured outcome, and hand day
      4 what it needs (isochrones snap to `h3_9`, already MATERIALIZED).
- [X] T020 Run `pnpm typecheck` in `web/` and re-run the full [quickstart.md](./quickstart.md)
      end to end.

---

## Dependencies & Execution Order

```
T001 (setup)
  └─ Phase 2: T002 → T003 ; T004 [P] ; T005 [P] ; T006
       └─ US1 (P1): T007 → T008 → T009 → T010 → T011 ; T012 [P] → T013 ✅ EXIT GATE
            ├─ US2 (P2): T014 → T015
            └─ US3 (P3): T016 → T017
                 └─ Polish: T018 [P], T019 [P], T020
```

- **Phase 2 blocks everything.** T005 especially: a tool that writes a part without it has
  bypassed the only thing preventing a dead run.
- **US2 and US3 are independent of each other**, both depend on US1's tools existing.
- T007–T010 share `chat.ts` ⇒ strictly sequential.

### Parallel opportunities

Genuinely different files, safe together:

- **T004 + T005** — `scoring.ts` and `layers.ts` (the two biggest foundational pieces).
- **T012** alongside T007–T011 — `attribution.tsx` touches nothing else.
- **T018 + T019** — two different docs.

Realistically this is one developer, so parallelism is a tiebreaker, not a plan.

## Implementation Strategy

**MVP is US1, and US1 alone.** T001 → T006 → T013. That is the day-3 exit gate, the demo
video's opening shot, and a complete submission on its own. Everything after it is insurance
and reach.

**Stop at T013 and validate before touching US2/US3.** If the top-3 isn't defensible, nothing
downstream matters — and the failure mode is subtle (a plausible-looking map pointing at the
commercial centre), so it must be checked against the reference SQL, not admired.

**Budget note**: DeepSeek balance was **$4.87** on 19 July. That is a day of iteration, not a
week. `./infra/check-env.sh` reports it; if it runs dry, drop `ANTHROPIC_BASE_URL` to fall
back to real Anthropic.

## Notes

- Commit after each task or logical group. Conventional Commits; no AI attribution.
- **Infra changes land in `infra/` in the same commit** (constitution IV) — that is T003's
  entire reason for existing.
- If a permission error appears, **do not run access DDL to fix it**. You need none:
  `GRANT SELECT ON web.*` already covers `web.layers`. `p_html`/`web_html`/`web_html2` are
  permanently wedged from exactly that instinct.
- An empty map with no error is almost always a swapped lat/lon. The whole H3 family is
  lat-first; GeoJSON wants `[lon, lat]`.
</content>
