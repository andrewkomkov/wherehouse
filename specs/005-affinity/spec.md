# Feature 005 — Complementary-business affinity

**Branch**: `005-affinity` · **Created**: 2026-07-17

## What

When advising where to open a trade, account for the *other* trades nearby — a barbershop next to
a cafe is a plus, a bookshop and a gym even more so. Each ranked pick gains a **neighbourhood-fit**
score computed from the mix of complementary businesses in its H3 ring, plus the top complementary
trades actually present. The agent may mention it; the UI shows it per pick.

## Honesty (constitution II) — this is EDITORIAL, and it says so

The affinity weights are a **hand-authored editorial heuristic** ("we think barbershops pair with
cafes"), NOT a measurement. Everywhere it appears it is labelled *editorial*. It does **not** enter
the measured GAP ranking (that stays demand × (100−supply) × accessibility). It is a *displayed
signal and an agent talking point*, so the ranking a judge can recompute by hand is unchanged. A
later, measured version could derive weights from Overture co-location lift — out of scope here.

Known caveat, stated: raw affinity-sum correlates with total neighbour density (dense areas have
more of everything). We keep the raw sum ("near N complementary businesses" = a footfall proxy) and
label it a heuristic rather than pretending it is normalised.

## Verified live 2026-07-17 (constitution II/III)

- SQL UDFs work on Cloud 26.4 (created/called/dropped `wh_probe_affinity`).
- **Complex-key dictionaries work on Cloud**: a `COMPLEX_KEY_HASHED` dict keyed `(target, neighbor)`
  returned `dictGetFloat32(...,('cafe','hair_salon'))` = 0.9, a miss = 0 (default). Cleaned up.
- Real Overture category strings (geo.places.category) confirmed: cafe, coffee_shop, hair_salon,
  beauty_salon, gym, sports_club_and_league, bakery, restaurant, bar, supermarket, art_gallery,
  clothing_store, hotel, park, pharmacy, dentist, doctor, physical_therapy, elementary_school,
  kindergarten, ev_charging_station, landmark_and_historical_building, bank_credit_union, ...
- Proven neighbourhood-fit query: per cell, `sum(dictGet(affinity,(target,category)))` over
  `arrayJoin(h3kRing(h3_8,1))` places.

## Design

- **Infrastructure (constitution IV)**: `db/clickhouse/007_affinity.sql` creates `geo.affinity`
  (target, neighbor, weight) with the editorial rows, and a `geo.affinity_dict` COMPLEX_KEY_HASHED
  dictionary over it. `infra/load-affinity.sh` applies and verifies it idempotently.
- **scoring.ts**: `affinityForCellsSql(city, category, h3Strings[])` → per pick, the fit score and
  the top ~3 complementary trades present in its ring. Computed only for the 3 picks (cheap), never
  the whole choropleth, and never folded into the gap.
- **chat.ts**: `rankSites` enriches each pick with `{ fit, neighbours: [{category, n}] }`; the
  prompt may mention the complementary trades near a pick, always as an editorial observation.
- **chat.tsx**: each pick row shows its neighbourhood-fit and the top complementary trades, with an
  "editorial" tag so it is never read as measured.

## Editorial affinity matrix (starter — the infra agent must verify each neighbor string exists in
geo.places and drop any that do not)

- bakery ← elementary_school .8, kindergarten .8, supermarket .6, cafe .5, coffee_shop .5, park .5, pharmacy .4
- cafe / coffee_shop ← art_gallery 1.0, hair_salon .9, beauty_salon .8, gym .8, hotel .7, park .7, clothing_store .6, bar .4
- pharmacy ← doctor 1.0, dentist .9, physical_therapy .8, supermarket .6, elementary_school .4
- restaurant ← hotel .9, bar .8, landmark_and_historical_building .7, art_gallery .6
- supermarket ← pharmacy .6, bakery .5, gas_station .5, bank_credit_union .4
- gym ← sports_club_and_league .9, physical_therapy .9, beauty_salon .7, cafe .5, coffee_shop .5
- kindergarten ← elementary_school .9, park .8, pharmacy .5, bakery .5

## Functional requirements

- **FR-001** Affinity weights live in ClickHouse as a dictionary, provisioned idempotently from the repo.
- **FR-002** Per-pick neighbourhood-fit MUST be computed from the pick's H3 ring business mix via the dict.
- **FR-003** Affinity MUST NOT change the GAP ranking — display + agent talking point only.
- **FR-004** Everywhere affinity shows, it MUST be labelled editorial (never presented as measured).
- **FR-005** The agent MAY name complementary trades near a pick ONLY from the tool payload.
- **FR-006** A pick with no complementary neighbours MUST render "no complementary trades nearby", not 0-as-fact.

## Cuts

- Measured co-location lift (a real, heavier version). Per-cell affinity across the whole choropleth.
  A re-weight slider for affinity (it is not a measured factor, so it does not join the sliders).
