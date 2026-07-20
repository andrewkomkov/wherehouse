# Spider-web catchment (Valhalla /expansion)

**Status:** designed + scaffolded (infra + schema landed 2026-07-20); the full batch and the
`web/` render change are not yet built. The `/expansion` shape and volume below are **proven
live**, not read — see "What was verified".

## What it is

Today the walk catchment is a Valhalla `/isochrone` **polygon** — a filled blob stored as
GeoJSON in `geo.isochrones` and painted as a translucent teal fill (`catchment` /
`catchment-line` in `web/src/components/chat.tsx`). It says "everything inside this line is
≤10 min away". True, but it hides the one thing that makes walkability interesting:
reachability follows **streets**, not a disc. A river with one bridge, a rail cutting, a
superblock with no through-path — the blob smooths over all of them.

The **spider web** draws the actual reachable street edges: the tree of road segments Valhalla
explored while computing that same isochrone, each coloured by how many minutes it takes to
walk there. Same routing run, opposite emphasis — the blob shows the *area*, the web shows the
*network* that produces it.

Valhalla's `/expansion` endpoint returns exactly this. It wraps `route` / `isochrone` /
`sources_to_targets` and emits the edges the underlying algorithm visited, as GeoJSON.

## Is `/expansion` the right tool? Yes — proven

Verified live 2026-07-20 against the **cached Berlin graph** (`valhalla_tiles.tar` from a prior
`infra/valhalla.sh build`), served by the same `docker-valhalla` image the script uses
(Valhalla 3.5.1). Container up in 3 s on prebuilt tiles; torn down after.

**Request** (`action=isochrone`, pedestrian, 10-min):

```json
POST /expansion
{
  "action": "isochrone",
  "costing": "pedestrian",
  "locations": [{ "lat": 52.5200, "lon": 13.4050, "search_cutoff": 150 }],
  "contours": [{ "time": 10 }],
  "expansion_properties": ["duration", "distance"],
  "skip_opposites": true,
  "dedupe": true
}
```

**Response** — a `FeatureCollection` of **one LineString Feature per graph edge**, each 2–4
points, each with an **accumulated** `duration` (seconds on foot to reach that edge) and
`distance` (metres):

```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature",
      "geometry": { "type": "LineString", "coordinates": [[13.408384,52.520739],[...]] },
      "properties": { "duration": 225, "distance": 319 } },
    ...
  ],
  "properties": { "algorithm": "dijkstras" }
}
```

That is the spider web, verbatim from the engine, no post-processing: a tree of street
LineStrings rooted at the origin, each tagged with when it was reached.

> Note the property names are **singular** in Valhalla 3.5.1 — `duration`, `distance`, `cost`,
> `edge_id`, `pred_edge_id`, `edge_status`, `expansion_type`. The plural `durations`/`distances`
> that some blog posts and the matrix-style docs suggest return HTTP 400
> `error_code 168 "Invalid expansion property type"`. Cost us one round-trip; grounded here so
> the next person skips it.

### One contour, not three (the design pivot)

`action=isochrone` runs **one unidirectional Dijkstra**, so every edge already carries its own
accumulated `duration`. A single `time:10` request therefore returns **every** edge reachable
within 10 min, each tagged with when — the 5-min sub-web is just `duration ≤ 300`. Storing
three contours (5/10/15) the way `geo.isochrones` does would triple the rows to re-derive
something the `duration` column already encodes. So we store **one** 10-min expansion per origin
and let the **renderer** threshold/colour by duration.

Verified: a standalone `time:5` request returned 972 edges; the `time:10` set filtered to
`duration ≤ 300` gave 892. The ~8% gap is boundary edges Dijkstra had *reached* but not
*settled* when the shorter run stopped early — cosmetically irrelevant for a painted line
layer (the difference is edges sitting exactly on the 5-min ring, coloured ~5-min either way).
This is a **visual**, not the set-containment contract `geo.isochrone_cells` is held to.

### Why 10 minutes

The rest of the product draws and scores the **10-min** catchment — `web/src/trigger/scoring.ts`
joins `geo.isochrone_cells` at `minutes = 10` and `catchmentSql` draws the `minutes = 10`
polygon. The spider web **replaces that polygon on screen**, so it must be the same 10 minutes
or the two disagree about what "the catchment" is. The `duration` column still gives a
within-web gradient (fast core → 10-min fringe) for free.

## The pipeline

Build-time batch, **exactly like the isochrones** — no runtime Valhalla. Same graph, same
candidate origins (`candidate_cells`: the res-9 children of every populated res-8 Kontur cell in
the city bbox), same `search_cutoff = 150` (a spider web and a blob for the *same* origin must
snap the same way or they describe different places), same skip-is-data / outage-is-not-a-skip
discipline, same verify-or-roll-back-the-partition guard.

```
infra/valhalla.sh expansion [cities...]
  build          # cached PBF -> cached graph tiles (shared with the isochrone path)
  expand_batch   # POST /expansion per origin -> expansion.tsv (origin_h3_9, duration_s, dist_m, geom)
  expand_load    # apply 012 schema -> DROP PARTITION -> INSERT -> expand_verify (rollback on fail)
```

Storage: **`geo.isochrone_edges`** (`db/clickhouse/012_isochrone_edges.sql`) — one row per edge,
`ORDER BY (origin_h3_9, duration_s)`, `PARTITION BY city`. It is the sibling of
`geo.isochrones` (the *pretty shape*, render-only), **not** of `geo.isochrone_cells` (the join
bridge). Nothing joins it; the scoring path is untouched. This is purely the alternative *look*.

The render assembles a `FeatureCollection` in SQL by grouping an origin's rows — the same
`concat` + `groupArray` pattern `scoring.ts::catchmentSql` already uses for the polygon.

### Volume — the honest number

This is **by far the heaviest table in the project**, and that is inherent: a blob is one ring,
a spider web is every edge under it. The Valhalla docs themselves warn expansion "can produce
gigantic GeoJSON responses of 100s of MB".

Measured on a 20-origin real Berlin sample (10-min, `skip_opposites` + `dedupe`):

| metric | value |
|---|---|
| edges per origin | min 67 · median 747 · max 3,190 · mean ~1,011 |
| stored bytes per edge | ~45 (geom text `[[lon,lat],[lon,lat]]` + 2× `UInt16`) |

Projected across the **20,724** origins that have an isochrone (three-city total from 006):

| | rows | raw | on disk (est.) |
|---|---|---|---|
| `geo.isochrone_edges` | **~21M** | **~950 MB** | **~100–200 MB** (MergeTree; durations cluster, neighbouring edges share high coordinate digits) |
| `geo.isochrones` (blob, for reference) | 63k | — | 16 MiB |
| `geo.isochrone_cells` (join bridge) | 635k | — | 915 KiB |

The web is ~10–15× the polygon store. If that is too much for the demo window, the honest knobs
— in order, both one-liners, neither needed for correctness — are: **cap the origin set** (build
edges only for pick-eligible cells) or **drop to a 5-min web**. Left at "all origins, 10 min" so
any click works, consistent with the isochrones.

### Stream cap → handle path (already handled)

A dense origin's `FeatureCollection` **exceeds the 1 MiB chat-stream cap**: central Berlin's
10-min web measured 3,812 edges / **1.06 MiB** raw GeoJSON (`skip_opposites` halves the ~2.1 MiB
without it). So the render takes the **handle path** — `web.layers` + a handle on the stream,
browser reads the GeoJSON straight from ClickHouse (ADR-003) — exactly like the GAP choropleth.
Sparse origins fall under `emitLayer`'s 256 KiB inline budget and stream inline.

**Nothing new is needed for this.** `web/src/trigger/layers.ts::emitLayer` already decides
inline-vs-handle on the *measured* byte-length of the payload, and the browser's `fetchLayer`
already resolves handles. The edges layer rides the same rails as every other over-budget layer.

## Render — the `chat.tsx` change (for the engineer who owns it)

**Do not** treat this as a new layer type. The catchment slot already exists; the web is a
different *geometry* in it, so the change is small and mostly a paint expression.

Current state (`web/src/components/chat.tsx`, ~L471–482): source `catchment` feeds two layers —
`catchment` (a `fill`) and `catchment-line` (a thin `line`, constant `C.accent`) — because the
blob is a Polygon.

For the spider web the source carries **LineString** features with a `duration` (seconds)
property. Minimal change:

1. **`catchment-line` → colour by duration.** Replace the constant `"line-color": C.accent`
   with a data-driven interpolate on the edge's duration, so the core reads fast and the fringe
   fades toward the 10-min edge. Keep it inside the existing teal family so it still reads as
   "the catchment":

   ```js
   "line-color": [
     "interpolate", ["linear"], ["get", "t"],   // "t" = duration seconds (see the SQL below)
     0,   "#d6fbff",   // on your doorstep — brightest
     300, C.accent,    // ~5 min
     600, "rgba(140,220,225,0.35)"  // ~10-min fringe — dim
   ],
   "line-width": 1.1,   // thin: it is a street, not a corridor
   ```

   The existing reveal animation already tweens `catchment-line`'s `line-width` / `line-opacity`
   and the visibility toggle already touches only the catchment layers — **both keep working
   unchanged** on a data-driven `line-color` (you only added an expression to a property the
   reveal doesn't animate).

2. **`catchment` fill → no-op / hide.** A `fill` layer over LineString features draws nothing,
   so it is harmless left as-is; cleanest is to pin its `fill-opacity` to 0 (there is no polygon
   to fill). The `CATCHMENT_FILL_OPACITY` paths in the reveal then simply animate an invisible
   layer — or drop them when you touch it.

That is the whole client change. No new source, no new layer id, no new toggle, no change to the
handle-fetch path.

### The SQL the tool emits (for whoever owns `web/src/trigger/scoring.ts`)

`showCatchment` would emit the edges `FeatureCollection` from `geo.isochrone_edges` instead of
(or alongside) the polygon, then hand it to the existing `emitLayer`, which auto-routes
inline-vs-handle. The origin is the pick's res-9 centre child — the **same** rule `catchmentSql`
already uses, so the web and the blob are one catchment drawn two ways:

```sql
WITH h3ToCenterChild(stringToH3({pick:String}), 9) AS oc
SELECT concat('{"type":"FeatureCollection","features":[',
  arrayStringConcat(groupArray(concat(
    '{"type":"Feature","geometry":{"type":"LineString","coordinates":', geom,
    '},"properties":{"t":', toString(duration_s), '}}')), ','),
  ']}')
FROM geo.isochrone_edges
WHERE origin_h3_9 = oc AND city = {city:String}
```

Zero rows ⇒ empty features array ⇒ the pick has no web (the same no-footpath-within-150 m miss
the polygon already has; the caller already handles it). `geom` is emitted **verbatim** —
Valhalla emits `[lon,lat]`, GeoJSON wants `[lon,lat]`, so there is **no coordinate swap** on
this path (see the trap block in 012 / 006).

## What was verified vs. read

**Verified live** (Berlin graph, 2026-07-20): the `/expansion` request is accepted; the output
is a `FeatureCollection` of per-edge LineStrings with scalar accumulated `duration`/`distance`;
the singular-vs-plural property-name gotcha; `skip_opposites` halving the response (1.06 vs
2.1 MiB); a single `time:10` expansion being a duration-filterable superset of `time:5`; and the
per-origin edge/byte distribution the volume estimate is built from (12 origins returning data
out of a 20-origin spread, matching the isochrone ~38% no-footpath skip rate).

**Read, not run** (grounded in the projection above, not measured end-to-end): the full
three-city 21M-row / ~100–200 MB on-disk figure — extrapolated from the sample, not from a
completed batch; the ClickHouse compression ratio; and the render, which is designed here but
not built (another engineer owns `web/`). The `expand_verify` reach ceiling (2,500 m) is a
hand-picked generous gross-error catch, **not** a measured bound — the execution step should
tighten it from real p99.9 the way the isochrone verify did.

## Attribution (non-optional wherever rendered)

routing / expansion: **Valhalla + OpenStreetMap contributors (ODbL)** — same as the isochrones.
