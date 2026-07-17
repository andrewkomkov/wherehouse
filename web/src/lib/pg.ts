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
 * so a MITM or a wrong host fails closed rather than connecting silently. The CA lives at
 * `.secrets/pg-ca.crt` (gitignored) — never printed, never committed.
 */

import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Both `next dev` and `trigger dev` run with cwd = web/, so the repo-root `.secrets` is one
// level up; the second path covers a run from the repo root itself. A deploy has no checked-in
// cert and must supply the CA another way (env-mounted file / secret) — provisioning concern,
// not this module's.
function readCa(): string {
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

/** One saved site as the panel reads it, joined to its shortlist for city/business context. */
export type SavedSiteRow = {
  id: number;
  shortlist_id: number;
  label: string;
  lon: number;
  lat: number;
  h3_8: string;
  /** null when never scored — the panel shows "unscored", not 0. */
  score: number | null;
  status: string;
  city: string;
  business_type: string;
  created_at: string;
};

/**
 * The panel's initial render. Postgres is authoritative here — the newest save is visible with
 * no CDC wait. Joins shortlists for the `city` filter (and to carry city/business_type out).
 * `created_at DESC` = newest first. There are no tombstones on the write side; the CDC target's
 * `_peerdb_is_deleted` filter is a read-side (ClickHouse) concern, not this one.
 */
export async function listSavedSites(
  userId: string,
  city?: string,
): Promise<SavedSiteRow[]> {
  const params: (string | number)[] = [userId];
  let cityFilter = "";
  if (city) {
    params.push(city);
    cityFilter = ` AND sl.city = $2`;
  }
  const result = await pool.query<{
    id: string;
    shortlist_id: string;
    label: string;
    lon: number;
    lat: number;
    h3_8: string;
    score: number | null;
    status: string;
    city: string;
    business_type: string;
    created_at: Date;
  }>(
    `SELECT ss.id, ss.shortlist_id, ss.label, ss.lon, ss.lat, ss.h3_8,
            ss.score, ss.status, sl.city, sl.business_type, ss.created_at
     FROM saved_sites ss
     JOIN shortlists sl ON sl.id = ss.shortlist_id
     WHERE ss.user_id = $1${cityFilter}
     ORDER BY ss.created_at DESC`,
    params,
  );
  return result.rows.map((r) => ({
    id: Number(r.id),
    shortlist_id: Number(r.shortlist_id),
    label: r.label,
    lon: r.lon,
    lat: r.lat,
    h3_8: r.h3_8,
    score: r.score,
    status: r.status,
    city: r.city,
    business_type: r.business_type,
    created_at:
      r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}
