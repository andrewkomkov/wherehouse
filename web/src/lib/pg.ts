/**
 * The write side. Everything a user saves lands in managed Postgres here, and ClickPipes
 * CDC ships it into ClickHouse (`oltp.pg_*`, ~5 s lag) for the analytical join. Postgres is
 * authoritative for the panel's initial render; ClickHouse is only for the market join.
 *
 * ## Why a Pool, and why one
 *
 * `next dev` and `trigger dev` are long-lived processes that fire concurrent writes; a single
 * module-level Pool gives us connection reuse without per-request TLS handshakes. It is a
 * singleton because a fresh Pool per import would leak sockets to a managed Postgres that
 * caps connections.
 *
 * ## TLS
 *
 * The managed Postgres presents a private CA; `sslmode=require` alone does NOT verify it
 * (constitution: verified against the live service — `verify-full` is what psql needs, and
 * node-postgres is the same). We pass the CA explicitly and keep `rejectUnauthorized: true`,
 * so a MITM or a wrong host fails closed rather than connecting silently. Locally the CA
 * comes from `.secrets/pg-ca.crt` (gitignored). A Trigger.dev deployed worker has no
 * filesystem access to that file (it isn't part of the deploy bundle, and `trigger deploy`
 * only ships what's statically imported) — there `POSTGRES_CA_CERT` (the same PEM, set as a
 * Trigger prod env var) is used instead. Discovered day 5: this read used to be eager and
 * unconditional at module load, so *every* chat message — not just saveSite — would have
 * crashed the deployed task at import time with no CA available.
 */

import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SavedSiteRow } from "./types";

// Re-exported so existing importers (the trigger task, this module's own callers) keep
// working unchanged. The canonical definition moved to `./types` (day 5) so the browser
// bundle can import the type without ever pulling in this module's `pg` / `node:fs` deps —
// see `types.ts` for why.
export type { SavedSiteRow };

// Both `next dev` and `trigger dev` run with cwd = web/, so the repo-root `.secrets` is one
// level up; the second path covers a run from the repo root itself. A deployed Trigger.dev
// worker has neither cwd — it supplies the same PEM via `POSTGRES_CA_CERT` instead (set from
// `.secrets/pg-ca.crt` by `infra/deploy-trigger.sh`), checked first so local dev's file stays
// the fallback rather than something that has to be kept in sync.
function readCa(): string {
  const fromEnv = process.env.POSTGRES_CA_CERT;
  if (fromEnv) return fromEnv;

  const candidates = [
    resolve(process.cwd(), "..", ".secrets", "pg-ca.crt"),
    resolve(process.cwd(), ".secrets", "pg-ca.crt"),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // try the next candidate; throw below if none resolve
    }
  }
  throw new Error(
    "Postgres CA not found at .secrets/pg-ca.crt (looked in ../ and cwd). " +
      "It is gitignored; fetch it via infra/status.sh's caCertificates step.",
  );
}

// POSTGRES_URL carries `sslmode=verify-full&sslrootcert=.secrets/pg-ca.crt` for psql (the
// cert path is repo-root-relative). node-postgres would read that path eagerly at connect
// time and miss it from cwd=web/. We govern TLS through the `ssl` object below instead, so
// strip the URL's ssl params; `rejectUnauthorized: true` + `ca` is the same verify-full.
function connectionString(): string | undefined {
  const url = process.env.POSTGRES_URL;
  if (!url) return undefined;
  const u = new URL(url);
  for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) {
    u.searchParams.delete(k);
  }
  return u.toString();
}

const pool = new Pool({
  connectionString: connectionString(),
  ssl: { ca: readCa(), rejectUnauthorized: true },
});

/**
 * Find-or-create the shortlist a save belongs to.
 *
 * A shortlist is the named search — "bakery in Berlin, walkable"; a save hangs off one. We key
 * it on (chat_id, user_id, city, business_type) so repeated saves in the same conversation land
 * under one shortlist rather than spawning a new one each time. `weights` keeps its `'{}'`
 * default; this feature does not set factor weights.
 *
 * Not a Postgres `ON CONFLICT` upsert: there is no unique constraint on that tuple in the
 * schema, and adding one is out of scope. SELECT-then-INSERT is adequate for a single-user
 * demo flow; a real concurrent writer would want the constraint.
 */
export async function upsertShortlist(input: {
  chatId: string;
  userId: string;
  city: string;
  businessType: string;
  title: string;
}): Promise<number> {
  const client = await pool.connect();
  try {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM shortlists
       WHERE chat_id = $1 AND user_id = $2 AND city = $3 AND business_type = $4
       LIMIT 1`,
      [input.chatId, input.userId, input.city, input.businessType],
    );
    if (existing.rows.length > 0) {
      return Number(existing.rows[0].id);
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO shortlists (chat_id, user_id, title, city, business_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.chatId, input.userId, input.title, input.city, input.businessType],
    );
    return Number(inserted.rows[0].id);
  } finally {
    client.release();
  }
}

/**
 * Persist one saved candidate site. `h3_8` is the join key into ClickHouse (computed app-side,
 * lat-first — see the H3 trap in CLAUDE.md); `score` is the last score we showed and MAY be
 * null (absent != 0 — an unscored save renders "unscored", never 0). `status` defaults to
 * 'candidate' to match the schema.
 */
export async function insertSavedSite(input: {
  shortlistId: number;
  userId: string;
  label: string;
  lon: number;
  lat: number;
  h3_8: string;
  score?: number | null;
  status?: string;
}): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO saved_sites (shortlist_id, user_id, label, lon, lat, h3_8, score, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'candidate'))
     RETURNING id`,
    [
      input.shortlistId,
      input.userId,
      input.label,
      input.lon,
      input.lat,
      input.h3_8,
      input.score ?? null,
      input.status ?? null,
    ],
  );
  return { id: Number(result.rows[0].id) };
}

// `SavedSiteRow` (one saved site as the panel reads it) now lives in `./types` — imported
// and re-exported above.
//
// The saved-sites LIST read lives in exactly two places, one per store the two runtimes can reach:
// the Worker's `handleListSaved` (Postgres via Hyperdrive, infra/app-worker/src/postgres.ts) and
// the browser's `fetchSavedSitesFromClickHouse` (ClickHouse direct). A third, Postgres-via-`pg`
// copy used to live here for a Next server action; the static export (`output: "export"`) has no
// server runtime to run it, so it had no caller and was removed rather than left to drift.
