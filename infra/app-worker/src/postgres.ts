import { Client } from "pg";
import type { Env } from "./env";
import { json } from "./cors";

/**
 * Save-site / list-saved, moved out of `web/src/lib/pg.ts` (Server-Action-only, and static
 * export has no server runtime). The schema and queries mirror that module exactly —
 * `db/postgres/001_oltp_schema.sql` is the source of truth for both.
 *
 * ## Why Hyperdrive, not raw `cloudflare:sockets`
 *
 * Verified live before writing this: a plain `pg` Client over `connect()` from
 * `cloudflare:sockets` (`pg-cloudflare`'s own supported path, `secureTransport: "starttls"`)
 * completes the TCP handshake and the Postgres SSLRequest exchange (`S` byte back) fine, but
 * the TLS socket closes itself asynchronously ~1s later, before the StartupMessage can be
 * sent — Cloudflare's Sockets API validates `startTls()` against the public root CA store
 * only, with no option to supply a custom CA, and our managed Postgres presents a private,
 * Ubicloud-issued CA (the same root cause as the documented `psql sslmode=require` failure).
 *
 * Hyperdrive DOES support a custom CA (`wrangler hyperdrive create --ca-certificate-id`,
 * cert uploaded via `wrangler cert upload certificate-authority`) and this was verified live
 * end-to-end: a real deployed Worker, bound to a Hyperdrive config pointed at the correct
 * root (the CA bundle in `.secrets/pg-ca.crt` actually holds TWO roots — an old/new pair —
 * only one of which signs the live leaf; `infra/deploy-app.sh` picks it the same way this
 * was verified: `openssl verify` against the live leaf cert), returned real rows
 * (`saved_sites` count) on 4/4 requests.
 */

async function client(env: Env): Promise<Client> {
  const c = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await c.connect();
  return c;
}

/**
 * The shortlist key's chat scope — MUST match `SAVE_CHAT_SCOPE` in web/src/trigger/chat.ts.
 *
 * Both save paths key a shortlist on (chat_id, user_id, city, business_type). This Worker path (the
 * map-click save) and the agent's `saveSite` tool have to use the SAME chat_id, or one (user, city,
 * trade) splits across two shortlist rows — there is no unique constraint to catch it. The Worker
 * used to key on the browser session's `chatId`, which the agent tool can never see, so a click
 * save and an agent save for the same trade landed under different shortlists. A fixed constant on
 * both sides collapses them to one. The `chatId` in the request body is now ignored for the key.
 */
const SAVE_CHAT_SCOPE = "wherehouse-demo";

export async function handleSaveSite(request: Request, env: Env): Promise<Response> {
  const input = (await request.json()) as {
    // Still accepted from the browser, but NO LONGER used as the shortlist key — see
    // SAVE_CHAT_SCOPE. Keying on the session chatId here split saves from the agent's saveSite
    // (which cannot see it) into a separate shortlist for the same (user, city, trade).
    chatId?: string;
    city: string;
    category: string;
    label: string;
    lon: number;
    lat: number;
    h3_8: string;
    score?: number | null;
  };

  const c = await client(env);
  try {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM shortlists
       WHERE chat_id = $1 AND user_id = $2 AND city = $3 AND business_type = $4
       LIMIT 1`,
      [SAVE_CHAT_SCOPE, "u1", input.city, input.category],
    );
    let shortlistId: number;
    if (existing.rows.length > 0) {
      shortlistId = Number(existing.rows[0].id);
    } else {
      const inserted = await c.query<{ id: string }>(
        `INSERT INTO shortlists (chat_id, user_id, title, city, business_type)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [SAVE_CHAT_SCOPE, "u1", input.label, input.city, input.category],
      );
      shortlistId = Number(inserted.rows[0].id);
    }

    const result = await c.query<{ id: string }>(
      `INSERT INTO saved_sites (shortlist_id, user_id, label, lon, lat, h3_8, score, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'candidate') RETURNING id`,
      [shortlistId, "u1", input.label, input.lon, input.lat, input.h3_8, input.score ?? null],
    );
    return json(request, env, { ok: true, id: Number(result.rows[0].id) });
  } catch (err) {
    return json(
      request,
      env,
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  } finally {
    await c.end();
  }
}

export async function handleListSaved(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const city = url.searchParams.get("city") ?? undefined;

  const c = await client(env);
  try {
    const params: (string | number)[] = ["u1"];
    let cityFilter = "";
    if (city) {
      params.push(city);
      cityFilter = " AND sl.city = $2";
    }
    const result = await c.query(
      `SELECT ss.id, ss.shortlist_id, ss.label, ss.lon, ss.lat, ss.h3_8,
              ss.score, ss.status, sl.city, sl.business_type, ss.created_at
       FROM saved_sites ss
       JOIN shortlists sl ON sl.id = ss.shortlist_id
       WHERE ss.user_id = $1${cityFilter}
       ORDER BY ss.created_at DESC`,
      params,
    );
    const rows = result.rows.map((r) => ({
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
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
    return json(request, env, rows);
  } catch (err) {
    return json(
      request,
      env,
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  } finally {
    await c.end();
  }
}
