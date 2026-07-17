# Feature 004 — Historical momentum: is this market rising, flat, or saturating?

**Branch**: `004-historical-momentum` · **Created**: 2026-07-17

## What

A monthly time series per (city, trade) over ~4.5 years, so the agent advises on **trend**, not just
today's snapshot: "cafes here are booming, bakeries are saturated." A signal the static GAP score
cannot see. Surfaced as a sparkline + a rising/flat/saturating badge, and a talking point the agent
may state (it is measured from OSM edit history).

## Verified live 2026-07-17 (constitution II/III)

- The naive Overture-diff source is **dead**: the public Overture bucket keeps only 2 releases.
- **ohsome API (HeiGIT)** — free, no auth, one POST — works and DISCRIMINATES (berlin, 2022→2026):
  bakery 1504→1427 (flat/decline), cafe 2315→2663 (+15%), ev_charging 312→1727 (**+450%**).
  Cross-validated: ohsome ~1450 bakeries ≈ our Overture 1460 (within 1%).
- OSM tag map validated live: gym→leisure=fitness_centre 282→467 (+66%), pharmacy→amenity=pharmacy
  823→766 (−7%), supermarket→shop=supermarket flat, hair_salon→shop=hairdresser +17%,
  kindergarten→amenity=kindergarten +7%. All plausible, all discriminate.

## The confound, stated not hidden (constitution II)

OSM counts rise partly because OSM *mapping* improves, not only because businesses open. Mitigation:
recent years only (2022+, where coverage is mature — the flat bakery curve proves coverage is not
dominating); frame as **relative momentum**, never absolute exhaustive counts; keep the ~1%
cross-validation against our own Overture count as a standing check. Never claim "always fresh" — a
monthly refresh of a slow-moving series; the honest pitch is a *self-sustaining pipeline*.

## Design

- **db/clickhouse/008_history.sql**:
  - `geo.poi_history` (city LowCardinality, category LowCardinality, month Date, count UInt32)
    ENGINE MergeTree ORDER BY (city, category, month). The insert target the loader writes.
  - `geo.category_momentum` — an **AggregatingMergeTree MATERIALIZED VIEW** over poi_history that
    maintains, per (city, category): argMinState(count, month), argMaxState(count, month),
    minState(month), maxState(month). Momentum (pct change first→last, direction) reads the Merge
    combinators. This is the genuine incremental-MV showcase: each monthly refresh updates it.
  - Header: the confound note + the cross-validation + "powered by the full OSM edit history via
    ohsome" (honest — ohsome queries the entire OSM history; we store the monthly rollup).
- **infra/load-history.sh** (like load-districts.sh): a python helper that, per (city, category),
  does ONE ohsome /elements/count POST over 2022-01-01/now/P1M with the Overture→OSM tag map, parses
  (month, count), streams TSV, INSERTs into geo.poi_history. Idempotent by DROP PARTITION per city.
  Verifies momentum: berlin cafe rising, bakery ~flat, ev_charging booming; nonzero exit otherwise.
- **scoring.ts** (or a small history.ts): `categoryTrendSql(city, category)` → the monthly series +
  first/last/pctChange/direction from geo.category_momentum.
- **chat.ts**: tool `categoryTrend(city, category)` → { direction, pctChange3y, monthly:[{month,count}] }
  (≤ ~54 numbers, fine to return). The agent MAY state the trend as measured **relative** momentum.
- **chat.tsx**: a sparkline + a rising/flat/saturating badge in the answer area (feeds F4 dashboard).

## Categories (real Overture → OSM tag)

bakery→shop=bakery, cafe→amenity=cafe, coffee_shop→amenity=cafe, restaurant→amenity=restaurant,
bar→amenity=bar, supermarket→shop=supermarket, pharmacy→amenity=pharmacy, gym→leisure=fitness_centre,
hair_salon→shop=hairdresser, clothing_store→shop=clothes, hotel→tourism=hotel,
ev_charging_station→amenity=charging_station, kindergarten→amenity=kindergarten,
elementary_school→amenity=school, art_gallery→tourism=gallery, doctor→amenity=doctors,
dentist→amenity=dentist, bank_credit_union→amenity=bank. (The loader owns this map.)

## Functional requirements

- **FR-001** Monthly history per (city, category) MUST be loaded from ohsome into ClickHouse,
  idempotently, from a script in the repo (constitution IV).
- **FR-002** Momentum MUST be maintained by a ClickHouse materialized view (the showcase), not
  computed ad hoc in app code.
- **FR-003** The agent MAY state the trend, framed as RELATIVE momentum from OSM history, and MUST
  NOT present absolute counts as exhaustive.
- **FR-004** The direction (rising/flat/saturating) MUST be derived from the measured series with a
  stated threshold, not asserted.
- **FR-005** A trade with too little history MUST render "not enough history", never a fake trend.

## Cuts

- Per-tile / per-district momentum and a momentum map layer (volume flex) — deferred; the per-(city,
  category) signal is the product value. A Trigger.dev monthly cron (the "self-sustaining pipeline")
  is F3b — wire only if cheap after the batch works.
