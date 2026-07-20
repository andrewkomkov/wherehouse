-- The "spider web": the actual reachable STREET EDGES from an origin, coloured by walk time.
--
-- geo.isochrones (006) stores the FILLED contour — a smooth blob that says "everything inside
-- this line is <=10 min away". True, but it hides the thing that makes walkability
-- interesting: reachability follows STREETS, not a disc. A river with one bridge, a rail
-- cutting, a superblock with no through-path — the blob glosses all of them; the spider web
-- shows them, because the tree of edges simply stops where the network stops.
--
-- This table is the same idea as geo.isochrones' pretty shape: a RENDER-ONLY artifact for one
-- origin, never joined. The join bridge is still geo.isochrone_cells (006) and the scoring
-- query is unchanged — the number under the map and the ranking do not come from here. This is
-- purely the alternative LOOK of the catchment the agent already computes.
--
-- SOURCE — Valhalla's /expansion endpoint, PROVEN LIVE against the cached Berlin graph
-- 2026-07-20 (Valhalla 3.5.1, docker-valhalla, serving the same tiles infra/valhalla.sh built):
--
--   POST /expansion
--   { "action":"isochrone", "costing":"pedestrian",
--     "locations":[{"lat":..,"lon":..,"search_cutoff":150}],
--     "contours":[{"time":10}],
--     "expansion_properties":["duration","distance"],
--     "skip_opposites":true, "dedupe":true }
--
--   -> { "type":"FeatureCollection",
--        "features":[ { "type":"Feature",
--                       "geometry":{"type":"LineString","coordinates":[[lon,lat],[lon,lat]]},
--                       "properties":{"duration":225,"distance":319} }, ... ],
--        "properties":{"algorithm":"dijkstras"} }
--
-- EACH graph edge is its own 2-4 point LineString Feature; `duration` is the ACCUMULATED
-- seconds-on-foot to reach that edge, `distance` the accumulated metres. It is the literal set
-- of edges Dijkstra settled while computing the isochrone — a tree rooted at the origin. That
-- is the spider web, verbatim from the engine, no post-processing.
--
-- WHY ONE CONTOUR, NOT THREE (the design pivot, verified 2026-07-20)
--
-- For action=isochrone the expansion is ONE unidirectional Dijkstra, so every edge already
-- carries its OWN accumulated `duration`. A single contours:[{time:10}] request therefore
-- returns EVERY edge reachable within 10 min, each tagged with when it was reached — the 5-min
-- sub-web is just `duration <= 300`. Storing three contours would triple the rows to re-derive
-- something the duration column already encodes. So we store the 10-min expansion once and let
-- the RENDERER colour/threshold by duration.
--
--   (Aside, measured: a standalone time=5 request returned 972 edges; the time=10 set filtered
--    to duration<=300 gave 892. The ~8% gap is boundary edges Dijkstra had "reached" but not
--    "settled" when the shorter run stopped early. Irrelevant for a painted street layer — the
--    difference is edges sitting exactly on the 5-min ring, coloured ~5-min either way. This is
--    a VISUAL, not the set-containment contract that geo.isochrone_cells is held to.)
--
-- WHY 10 MINUTES. The rest of the product draws and scores the 10-min catchment
-- (web/src/trigger/scoring.ts joins geo.isochrone_cells at minutes=10 and catchmentSql draws
-- the minutes=10 polygon). The spider web REPLACES that polygon on screen, so it must be the
-- same 10 minutes or the two disagree about what "the catchment" is. The duration column still
-- lets the renderer show a within-web gradient (fast core -> 10-min fringe).
--
-- Built by infra/valhalla.sh (the `expansion` subcommand: same graph, same origins, same
-- search_cutoff=150 as the isochrones — a spider web and a blob for the SAME origin must agree).
-- ClickHouse Cloud 26.4, eu-west-1.

CREATE DATABASE IF NOT EXISTS geo;

---------------------------------------------------------------------------------------
-- COORDINATE ORDER — the trap, restated because it never stops being true.
--
-- Valhalla emits GeoJSON. GeoJSON coordinates are [lon, lat]. The `geom` column is stored
-- EXACTLY as Valhalla emitted it, and is only ever handed to the browser (which also wants
-- [lon,lat]) — so, like geo.isochrones.geojson, there is NO swap anywhere on this path. Do not
-- "tidy" it into (lat,lon). The moment anyone computes H3 from these coordinates (they should
-- not — this table is render-only), h3 is lat-first and the whole 006 trap block applies.
---------------------------------------------------------------------------------------

---------------------------------------------------------------------------------------
-- SHAPE: a fact table of edges — one row per reachable street segment, mirroring the way
-- geo.isochrone_cells is one row per reachable cell and geo.isochrones is one row per lobe.
-- The renderer GROUPs an origin's rows and assembles a FeatureCollection in SQL, exactly as
-- web/src/trigger/scoring.ts catchmentSql already does for the polygon (concat + groupArray).
-- One row per edge (not one blob per origin) so ClickHouse compresses the duration and geom
-- columns columnar, and so `duration <= 300` for the 5-min sub-web is an indexed range, not a
-- JSON parse.
--
-- SIZE — this is BY FAR the heaviest table in the project, and that is inherent, not a bug.
-- The Valhalla docs themselves warn expansion "can produce gigantic GeoJSON responses of 100s
-- of MB": a blob is one ring, a spider web is every edge under it.
--
-- MEASURED on a 20-origin real Berlin sample, 2026-07-20 (10-min, skip_opposites+dedupe):
--
--     per-origin edges:  min 67   median 747   max 3190   mean ~1011
--     per-edge stored:   ~45 bytes (geom text [[lon,lat],[lon,lat]] + 2x UInt16)
--
-- Projected across the 20,724 origins that have an isochrone (006's three-city total):
--
--     ~21M edge rows,  ~950 MB RAW  ->  expect ~100-200 MB on disk after MergeTree
--     compression (durations cluster, neighbouring edges share high coordinate digits).
--
-- For comparison: geo.isochrones is 16 MiB and geo.isochrone_cells 915 KiB. The spider web is
-- ~10-15x the polygon store. That is the price of showing the streets instead of the blob.
-- If it is too much for the demo window, the honest knobs are, in order: cap the origin set
-- (build edges only for pick-eligible cells), or drop to a 5-min web. Both are one-line changes
-- in infra/valhalla.sh; neither is needed for correctness, only for disk.
--
-- STREAM CAP: a dense origin's FeatureCollection EXCEEDS the 1 MiB chat-stream cap — central
-- Berlin's 10-min web measured 3,812 edges / 1.06 MiB raw GeoJSON (skip_opposites halves the
-- ~2.1 MiB raw). So the render takes the HANDLE path (web.layers, 004) for dense origins
-- exactly like the GAP choropleth; sparse origins fall under emitLayer's 256 KiB inline budget
-- and stream inline. web/src/trigger/layers.ts::emitLayer already decides this per measured
-- byte-length — nothing new is needed there.
---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo.isochrone_edges
(
    -- The origin whose expansion this edge belongs to. Same res-9 cell id, same snapping,
    -- same search_cutoff=150 as geo.isochrones — the spider web and the blob are two views of
    -- ONE routing run and must not be computed from different origins.
    origin_h3_9 UInt64,

    -- Accumulated seconds on foot to reach this edge (Valhalla's per-edge `duration`). The
    -- renderer colours by this: fast core -> 10-min fringe. Mostly <= 600 (10 min); a handful
    -- of boundary edges Dijkstra "reached" sit just over it — kept, not clipped (the fringe is
    -- part of the shape). UInt16 covers 0..65535 s with room to spare.
    duration_s  UInt16,

    -- Accumulated metres along the network to reach it (Valhalla's `distance`). Not currently
    -- painted; stored because it is one extra byte-cheap column and answers "how far along the
    -- street", which crow-flies distance cannot.
    dist_m      UInt16,

    -- The edge geometry as a GeoJSON LineString `coordinates` array: [[lon,lat],[lon,lat],..],
    -- 2-4 points. Stored as TEXT and shipped to the browser verbatim, same reasoning as
    -- geo.isochrones.geojson: (1) it goes out unchanged, a native Ring type would only be
    -- marshalled back to JSON on the way out; (2) Cloud is 26.4 and the GeoJSON output format
    -- needs 26.6 (verified absent). [lon,lat], as emitted. Do not swap it.
    geom        String,

    -- berlin | amsterdam | belgrade. Per-city reload is a DROP PARTITION, as everywhere else.
    city        LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY city
-- The read is always "given this origin, every edge, ordered by travel time" -> the sort key
-- is the lookup prefix, so an origin's web is one contiguous granule range, and the edges
-- arrive PRE-SORTED by duration, which is exactly the order a fade-in gradient wants to paint.
ORDER BY (origin_h3_9, duration_s);

---------------------------------------------------------------------------------------
-- HOW THIS IS MEANT TO BE READ — the render query the showCatchment tool would run (this is
-- the SQL another engineer would add to web/src/trigger/scoring.ts; it is NOT run here).
--
-- "Draw the walk catchment of this pick as a spider web." One Feature per edge, duration in
-- properties so the client can colour it. Origin is the pick's res-9 centre child — the SAME
-- rule scoring.ts already uses for the polygon (its D2), so the web and the blob are the same
-- catchment drawn two ways, never two measurements that can drift.
--
--   WITH h3ToCenterChild(stringToH3({pick:String}), 9) AS oc
--   SELECT concat('{"type":"FeatureCollection","features":[',
--     arrayStringConcat(groupArray(concat(
--       '{"type":"Feature","geometry":{"type":"LineString","coordinates":', geom,
--       '},"properties":{"t":', toString(duration_s), '}}')), ','),
--     ']}')
--   FROM geo.isochrone_edges
--   WHERE origin_h3_9 = oc AND city = {city:String};
--
-- Zero rows -> empty features array -> the pick has no spider web (the same no-footpath-within
-- -150 m miss geo.isochrones has; the caller already handles it for the polygon). No geometry
-- op, no routing engine at runtime: geometry was resolved once, offline, into edge rows.
--
-- ATTRIBUTION, non-optional wherever this is rendered (identical to the isochrones):
--   routing/expansion: Valhalla + OpenStreetMap contributors (ODbL)
---------------------------------------------------------------------------------------
