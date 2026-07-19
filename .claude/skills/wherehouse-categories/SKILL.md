---
name: "wherehouse-categories"
description: "Manage the trades the WhereHouse agent can answer for. Add/remove a category so it 'shines' end-to-end (POI in all 3 cities + affinity F5 + trend F3), navigating the Overture-vs-friendly naming trap. Load when asked to add, remove, or audit queryable categories."
user-invocable: true
disable-model-invocation: false
metadata:
  author: "wherehouse"
  domain: "data / agent tools"
---

# Managing queryable categories

The trades the model may ask about live in `CATEGORY_SYNONYMS` in `web/src/trigger/chat.ts`. The rule for
the demo: **only expose categories that SHINE** — correct end-to-end across all three signals:
1. **POI** in all three cities (`geo.places`, used by every map/score/rank/catchment tool),
2. **Affinity F5** (`geo.affinity` target → the editorial neighbourhood-fit signal),
3. **Trend F3** (`geo.poi_history` / `geo.category_momentum` → the momentum sparkline).

Current shining set (9): **bakery, cafe, restaurant, pharmacy, supermarket, gym, dentist, hair_salon,
hotel** + the `food and drink` GROUP (= restaurant+cafe+bakery, kept wide enough to exceed the ~256 KiB
inline budget so it demos the 1 MiB stream-cap handle path).

## THE NAMING TRAP — the one thing to get right
`geo.places` stores **raw Overture category names** (there are ~1520 of them). The affinity and history
loaders used **friendly names**. They line up ONLY when the friendly name equals the Overture name — which
happens to be true for the shining trades (bakery=bakery, cafe=cafe…), and is why they work. It is NOT true
in general:
- `kindergarten` → **0 rows** in geo.places. Overture calls it `child_care_and_day_care` (350),
  `preschool` (945), `day_care_preschool` (262). It was *advertised* to the model and headlined in the
  README, but every query returned "no data" / an empty map. (And its affinity/history were keyed on
  `kindergarten`, so even remapping places would desync the joins.)
- `fast_food` → 0 rows (Overture: `fast_food_restaurant`, 941).
- `cafe` (3408) does NOT include `coffee_shop` (1877) — a separate Overture category. `restaurant` (4537)
  excludes cuisine subtypes (`italian_restaurant` 1637, …). Single-category queries undercount silently.

`resolveCategories(word)` returns the Overture-name list used to filter `geo.places`; `cats[0]` is ALSO the
key used for the affinity target and the trend category. So a category's primary Overture name must match
its `geo.affinity`/`geo.poi_history` rows. Keep them consistent or the affinity/trend joins miss.

## Add a category so it shines
1. **Verify POI per city.** `SELECT category, countIf(city='berlin'), countIf(city='amsterdam'),
   countIf(city='belgrade') FROM geo.places WHERE category='<overture_name>' GROUP BY category`. All three
   must be > 0. If the friendly word ≠ Overture name, resolve the real name(s) first (grep the taxonomy:
   `SELECT DISTINCT category FROM geo.places WHERE category ILIKE '%<word>%'`).
2. **Author affinity F5** in `db/clickhouse/007_affinity.sql`: add `('<target>', '<overture_neighbour>',
   weight)` rows. Weights are 0..1 **editorial** opinion (labelled, never measured, never in the GAP rank).
   Every `neighbour` must exist in `geo.places.category` (verify counts). Then `./infra/load-affinity.sh`
   (DROP+CREATE+INSERT+verify — it asserts the dict answers and a sample fit > 0). Confirm:
   `dictGetFloat32('geo.affinity_dict','weight',('<target>','<neighbour>'))`.
3. **Check trend F3.** `SELECT count() FROM geo.poi_history WHERE category='<target>'`. If absent, the trade
   still works but `categoryTrend` returns "not enough history" (handled honestly). To make it shine, the
   history loader (`infra/load-history.sh`, ohsome/OSM) must backfill that category under the SAME name.
4. **Expose it.** Add to `CATEGORY_SYNONYMS` (friendly words → `[overture_name(s)]`). The model's category
   list is auto-generated from `Object.keys(CATEGORY_SYNONYMS)` in the `target` zod schema — no other edit.
   Also check `web/src/components/chat.tsx` `LANDING_SUGGESTIONS`/`SUGGESTIONS` only reference shining trades.
5. **Typecheck** (`cd web && pnpm typecheck`) and **run a live spot-check** of `rankSites` SQL for the new
   trade (real picks + district names).

## Make it live
`chat.ts` IS the Trigger.dev task, so category changes need **`./infra/deploy-trigger.sh`** to reach the live
agent (the affinity/history data is already live once loaded). Then verify through the DEPLOYED agent (see
the `wherehouse-validate` skill's headless `AgentChat` driver): a "<new trade> in Berlin" run should call all
5 tools and its `competitors` layer rowCount should equal the trade's Berlin POI count.

## Remove / trim
Just delete the synonyms from `CATEGORY_SYNONYMS` (leave the ClickHouse data — removing exposure is enough),
fix any doc/example that advertised it, and redeploy the task. Verify `Object.keys(CATEGORY_SYNONYMS)` no
longer contains it.
