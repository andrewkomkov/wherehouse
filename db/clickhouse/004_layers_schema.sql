-- The by-reference layer store — the mitigation for the 1 MiB chat-stream cap.
--
-- The Trigger.dev chat stream caps a SINGLE record at ~1 MiB, `data-map` parts included,
-- and it cannot be raised. Crossing it fails the run with ChatChunkTooLargeError. We already
-- exceed it: the Berlin GAP choropleth is 549 KiB (54% of the cap, no safe margin) and
-- "every Berlin POI" is 14.9 MiB — 14x over.
--
-- So a layer above the budget doesn't travel on the stream at all. It lands here, the stream
-- carries only a small handle, and the BROWSER reads the GeoJSON straight out of ClickHouse
-- (ADR-003 proved Cloud serves HTTP with CORS open). The constraint turns into the stunt:
-- on stage the browser talks to ClickHouse directly.
--
-- Verified end-to-end 2026-07-19 with the real 549 KiB choropleth:
--   INSERT (default user) 770 ms -> GET (site user, readonly=1, Origin set) 550 ms
--   -> byte-identical, 2,260 cells.
--
-- Load with infra/load-layers.sh.

CREATE DATABASE IF NOT EXISTS web;

CREATE TABLE IF NOT EXISTS web.layers
(
    -- The handle. Random and unguessable: it is the only thing between a public readonly
    -- user and this row, and layers are per-question.
    id         String,

    -- The complete GeoJSON FeatureCollection, assembled by hand in SQL. Cloud is 26.4 and
    -- the `GeoJSON` format needs 26.6 (verified absent; Cloud trails OSS ~2 releases, so
    -- do not wait for it).
    body       String,

    created_at DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY id
-- A row is written once and read once or twice within seconds. The TTL is here so a week of
-- demos doesn't accumulate; it is NOT a cache. Don't add reuse or invalidation logic.
TTL created_at + INTERVAL 1 HOUR;

---------------------------------------------------------------------------------------
-- WHY THIS TABLE LIVES IN `web` AND NEEDS NO GRANT — read before "fixing" a permission
-- error here.
--
-- `site` already holds `GRANT SELECT ON web.*`. That is a WILDCARD over the database, so it
-- covers this table the moment it exists. Verified by canary on 2026-07-19: a brand-new
-- web.* table was read by `site` with no GRANT issued for it.
--
-- This is deliberate, not a shortcut. Running access DDL (CREATE USER / CREATE SETTINGS
-- PROFILE / GRANT) is how we permanently wedged p_html, web_html and web_html2 — CREATE says
-- "already exists in `replicated`" while DROP/ALTER say "there is no settings profile". That
-- state is unrecoverable without support. A design that needs zero access DDL cannot step on
-- that mine.
--
-- So: if the browser gets a permissions error, the fix is NOT a GRANT. Check that the table
-- is in `web` and that you are authenticating as `site`.
---------------------------------------------------------------------------------------
