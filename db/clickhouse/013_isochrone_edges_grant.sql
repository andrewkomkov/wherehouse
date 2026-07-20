-- Lets the browser read geo.isochrone_edges directly as the read-only `site` user, so a
-- click on a top-pick pin can draw THAT pick's spider-web catchment client-side (compare the
-- walkability of picks by clicking them) — the same browser-direct-to-Cloud pattern already used
-- for web.layers / web.assets / oltp.* (see 004_layers_schema.sql, 010_oltp_grants.sql).
--
-- The `catchment` layer the agent's showCatchment tool draws goes through the handle path
-- (web.layers), so it needs no geo grant; this client-side click feature queries the edges table
-- directly, which the wildcard `GRANT SELECT ON web.* TO site` does not cover (geo.* is a different
-- database). Table-level SELECT, read-only — the table is render-only geometry (origin_h3_9,
-- duration_s, dist_m, geom, city), nothing sensitive.
--
-- A GRANT, not CREATE USER / SETTINGS PROFILE — lower-risk than the DDL family that wedged
-- p_html/web_html during a version upgrade (CLAUDE.md trap #4), but the same rule holds: confirm
-- SELECT version() is stable (no mid-upgrade state) before running. Verified stable (26.4.1.2029).

GRANT SELECT ON geo.isochrone_edges TO site;
