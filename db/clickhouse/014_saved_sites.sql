-- The user's saved sites, stored in ClickHouse itself.
--
-- This REPLACES the OLTP side of the retired ADR-004 (managed Postgres -> ClickPipes CDC ->
-- `oltp.pg_saved_sites` / `oltp.pg_shortlists`). That whole path existed for the hackathon's
-- OLTP+OLAP bonus; with the hackathon over it was three moving parts (a Postgres instance, a
-- CDC pipe, a Cloudflare Hyperdrive config + custom-CA upload) carrying five rows of state.
-- See docs/architecture/oltp-olap.md for the superseding note.
--
-- What changes for the app: nothing the user can see. What changes for the code:
--
--   * ONE table instead of two. `shortlists` existed to hang (city, business_type) off a save;
--     both are plain columns here, so every read loses a JOIN. `shortlist_id` was never rendered
--     anywhere (verified before removing it) — it only ever fed that JOIN.
--   * No replication lag. The write is the read: an INSERT here is visible to the very next
--     SELECT, where CDC took ~10 s and needed `_peerdb_is_deleted` tombstone filters.
--   * `score` is genuinely Nullable. The live ClickPipe was created with
--     `allowNullableColumns: false` and collapsed a NULL score to 0.0 — latent-but-real, since
--     "absent != 0" is a hard project invariant (FR-006). Owning the DDL fixes it outright.
--
-- Still ReplacingMergeTree + FINAL on read: an edit to a saved site is written as a new version
-- of the same `id` (the engine's dedup key is the ORDER BY tuple), and `updated_at` picks the
-- winner. Nothing edits a site today; the engine is chosen so that when something does, the read
-- path already collapses versions instead of showing both.

CREATE DATABASE IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.saved_sites
(
    -- UUID, not a counter: ClickHouse has no sequences, and the two writers (the Trigger.dev
    -- agent's `saveSite` tool and the Worker's `/api/save-site`) insert independently with no
    -- shared transaction to allocate from. The DEFAULT covers the agent path, which never needs
    -- to know the id; the Worker supplies its own (`crypto.randomUUID()`) because it hands the id
    -- straight back to the browser for its optimistic row.
    id             UUID DEFAULT generateUUIDv4(),
    user_id        String,
    -- The city and the trade word the user actually typed ('bakery', or a group like
    -- 'food and drink'), NOT the resolved Overture taxonomy the GAP surface is scored on.
    -- `savedSitesRowsSql` matches on this string by equality — same contract the retired
    -- `shortlists.business_type` column had.
    city           LowCardinality(String),
    business_type  String,
    label          String,
    note           String DEFAULT '',
    lon            Float64,
    lat            Float64,
    -- The join key into the scored surface: `stringToH3(h3_8) = scored.cell`, H3 equality with
    -- no interpolation. Computed writer-side, lat-first (see the H3 trap in CLAUDE.md).
    h3_8           String,
    -- NULL when the site was never scored. The panel renders that as "unscored", never 0.
    score          Nullable(Float32),
    status         String DEFAULT 'candidate',  -- candidate | shortlisted | rejected | signed
    created_at     DateTime64(3) DEFAULT now64(3),
    updated_at     DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (user_id, city, business_type, id);

-- Same browser-direct-to-Cloud read posture as `web.layers` / `web.assets`: the panel's saved
-- list is fetched by the public read-only `site` user straight from the browser. `app` is a
-- different database from `web`, so the existing wildcard `GRANT SELECT ON web.*` does not
-- reach it — this is the one piece of access DDL this table needs.
--
-- A GRANT, not a CREATE USER / CREATE SETTINGS PROFILE (the family that permanently wedged
-- p_html / web_html / web_html2 when run mid-upgrade — CLAUDE.md trap #4). Still: confirm
-- `SELECT version()` is stable across several probes before running it. Verified stable
-- (26.4.1.2029 x3) on 2026-08-01.
GRANT SELECT ON app.saved_sites TO site;
