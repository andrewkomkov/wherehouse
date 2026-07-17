# Feature 003 — Saved-site history: your sites vs the market

**Branch**: `003-saved-site-history` · **Created**: 2026-07-17 · **Prize**: OLTP+OLAP bonus

## What

A persistent history of saved sites, and a comparison that re-scores each saved site against
*today's* market. This is the OLTP+OLAP bonus-prize story (ADR-004): a seconds-old Postgres row
joined against 75M Overture POIs, on `h3_8` equality, with no interpolation.

Two save flows, both writing to managed Postgres → ClickPipes CDC → ClickHouse:
1. **Chat command** — the agent's `saveSite` tool ("save the top pick", "save Lichtenrade").
2. **Map / rail** — a Save affordance on each ranked pick (a server action).

Then `compareSavedSites` reads the replicated rows and re-scores them against the live GAP
surface, emitting a `saved` map layer and a short comparison. The UI shows a "Saved sites" panel
(the history) and pins.

## Verified against the live system — 2026-07-17 (constitution II/III)

- **CDC round-trip is fast**: a fresh `INSERT` into Postgres `saved_sites` appeared in ClickHouse
  `oltp.pg_saved_sites` in **~5 s** (canary id=35, then deleted). Proven, not assumed.
- **The join is real and meaningful**. Each saved Berlin site, re-scored vs today's bakery market:

  | saved site | h3_8 | market gap today | residents | rivals in ring |
  |---|---|---|---|---|
  | Kastanienallee corner | 881f1d4881fffff | **0.0** | 3,725 | 25 |
  | Boxhagener Platz | 881f1d4885fffff | 5.4 | 1,772 | 10 |

  Both saved sites are central and score **low** — the honest, useful message ("you saved trendy
  but saturated corners") is the story, and it falls straight out of the data.

  *(Boxhagener was 18.2 when this feature was first probed against a two-term market; it is 5.4
  now because feature 002 folded accessibility into the same `candidateCells` this join reuses, so
  a saved site is re-judged against the current three-term market. That live re-scoring — not the
  score stored at save time — is the whole point.)*
- **Schema already models history** (no new tables): `oltp.pg_shortlists` (chat_id, user_id, city,
  business_type, **weights**, created_at) and `oltp.pg_saved_sites` (label, note, lon, lat, **h3_8**,
  score, status, created_at). `h3_8` is the join key to `geo.places` / `geo.population`.
- The app currently has **no** Postgres wiring — F2 is greenfield on the app side. The day-2
  `showSavedSites` scaffolding is already gone.

## The join query (proven)

```sql
-- each saved site of a user, re-scored against the current market for (city, category).
-- candidateCells CTE is scoring.ts's; the new part is the LEFT JOIN from oltp.pg_saved_sites.
SELECT ss.label, ss.h3_8, round(sc.gap,1) AS market_gap_today, sc.pop AS residents, sc.sup AS rivals
FROM oltp.pg_saved_sites ss
LEFT JOIN scored sc ON stringToH3(ss.h3_8) = sc.cell
WHERE ss._peerdb_is_deleted = 0 AND ss.user_id = {user}
ORDER BY ss.created_at
```

`_peerdb_is_deleted = 0` is mandatory — CDC keeps tombstones; without it a deleted site reappears.

## User stories

- **US1 (P1) — Save a pick.** From a ranked answer, the user saves the top pick (chat: "save the
  best one"; or a Save button on the pick row). It lands in Postgres and, within seconds, in
  ClickHouse. Confirmed by the site appearing in the Saved-sites panel.
- **US2 (P1) — Your sites vs the market.** "How do my saved sites compare?" → `compareSavedSites`
  re-scores each against today's GAP surface, drops pins on the map (coloured by `market_gap_today`),
  and the agent says the pattern in ≤2 sentences. The freshness is the point: a site saved seconds
  ago is already in the comparison.
- **US3 (P2) — Return to history.** The Saved-sites panel lists the history (label, saved score,
  status, market gap today, date); it persists across reloads because it lives in Postgres.

## Functional requirements

- **FR-001** `saveSite` MUST write to Postgres (not ClickHouse) — CDC carries it to ClickHouse.
  It re-derives the chosen pick via `rankSql` (never trusts a model-supplied h3/score), resolves or
  creates a shortlist for (chat_id, city, business_type), and INSERTs label/lon/lat/h3_8/score.
- **FR-002** A map/rail Save affordance MUST write the same way via a server action.
- **FR-003** `compareSavedSites` MUST read `oltp.pg_saved_sites` filtered `_peerdb_is_deleted=0` and
  join on `stringToH3(h3_8)` equality against the live scored CTE; it MUST emit a `saved` layer and
  return only a small summary to the model (ADR-001).
- **FR-004** The `saved` layer pins MUST be visually distinct from the agent's own `picks` (these are
  the user's sites, not the agent's recommendations) and carry `market_gap_today` per site.
- **FR-005** The Saved-sites panel MUST show the persisted history and survive a page reload.
- **FR-006** A site with no market score (h3 outside the city bbox) MUST render as "unscored", never 0.
- **FR-007** The model MUST NOT invent a saved site or its score — both come from the tool payload.
- **FR-008** Secrets: the Postgres connection uses `POSTGRES_URL` + the CA from `.secrets/`; no
  credential enters git (constitution V). Local `trigger dev` has the CA; note this for deploy.

## Cuts (constitution VI)

- Editing/deleting saved sites from the UI — status is enough for the demo; delete is a Postgres op.
- Multi-user auth — `user_id` is a fixed demo id (`u1`), same as today.
- Re-running the agent's full ranking for saved sites — the compare uses the same scored CTE once.

## Assumptions

- `weights` on a shortlist is stored but not yet replayed into the UI sliders (nice-to-have, cut).
- One demo user `u1`; shortlists key on (chat_id, city, business_type).
