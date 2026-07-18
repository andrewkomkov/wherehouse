-- ADR-003 "for real": the Next.js static export, one row per file, served by the
-- Cloudflare Worker in infra/app-worker/ (which reads this table with the existing
-- read-only `site` user — no new access DDL needed, see the note below).
--
-- Distinct from web.pages (the original ADR-003 proof-of-concept, a single hand-written
-- HTML string) and web.layers (the by-reference GeoJSON handle store for F1's progressive
-- map, see docs/architecture/progressive-map.md) — neither is touched by this.
--
-- Loaded by infra/deploy-app.sh, which TRUNCATEs and reloads on every deploy: the bundle
-- is small (a few MB) and Next's content-hashed filenames mean a naive re-INSERT would
-- accumulate orphaned rows from previous builds forever otherwise.

CREATE DATABASE IF NOT EXISTS web;

CREATE TABLE IF NOT EXISTS web.assets
(
    -- The request path, e.g. '/index.html', '/_next/static/chunks/main-app-....js',
    -- '/fonts/ibm-plex-sans.woff2'. '/' itself is normalised to '/index.html' by the
    -- Worker, not stored twice here.
    path         String,

    -- Raw file bytes. May be non-UTF8 (woff2, favicon) — ClickHouse String is a byte
    -- string, not required to be valid UTF-8, so this is safe; it's read back via
    -- `FORMAT RawBLOB`, never a text-oriented format that could mangle it.
    body         String,

    content_type String,

    updated_at   DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY path;

---------------------------------------------------------------------------------------
-- WHY THIS NEEDS NO GRANT — read before "fixing" a permission error here.
--
-- `site` already holds `GRANT SELECT ON web.*` (a wildcard over the whole database), which
-- covers this table the instant it exists — verified for web.layers on 2026-07-19 and true
-- here for the same reason. Do NOT run `GRANT` / `CREATE USER` / `CREATE SETTINGS PROFILE`
-- to "fix" a read failure on this table: that access-DDL family is what permanently wedged
-- p_html, web_html and web_html2 (CREATE says "already exists in `replicated`", DROP/ALTER
-- say "there is no settings profile"). If the Worker can't read web.assets, the bug is
-- elsewhere (path normalisation, FINAL, credentials) — not a missing grant.
---------------------------------------------------------------------------------------
