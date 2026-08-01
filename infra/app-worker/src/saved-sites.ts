import type { Env } from "./env";
import { json } from "./cors";

/**
 * The map-click save. One row into `app.saved_sites` (db/clickhouse/014_saved_sites.sql).
 *
 * ## Why this endpoint exists at all
 *
 * Reads go browser-direct to ClickHouse as the public read-only `site` user (ADR-003), and the
 * saved-list read does too — see `fetchSavedSitesFromClickHouse` in web/src/components/chat.tsx.
 * A WRITE cannot: it needs a credential that can INSERT, and shipping one in the client bundle
 * would let anyone write to the table. So the Worker holds `app_writer` (GRANT INSERT, SELECT ON
 * app.saved_sites — that table and nothing else; verified: `SELECT count() FROM geo.places` as
 * this user returns 497 ACCESS_DENIED) and the browser posts here.
 *
 * ## What this replaced
 *
 * Until 2026-08-01 both halves went through managed Postgres over a Hyperdrive binding, and
 * ClickPipes CDC replicated them back into ClickHouse for the analytical join (ADR-004). That
 * bought a genuine OLTP+OLAP story for the hackathon and, afterwards, three moving parts (a
 * Postgres instance, a CDC pipe, a Hyperdrive config with a custom-CA upload — raw
 * `cloudflare:sockets` could not validate our Postgres's private CA) holding five rows. ADR-005
 * retires it: ClickHouse is the only store, so the write is immediately visible to the next read
 * instead of ~10 s behind it.
 *
 * Plain `fetch`, not `@clickhouse/client`: the Worker runtime is workerd, and the HTTP interface
 * is one POST. `input_format_null_as_default=0` is load-bearing — without it a JSON `null` score
 * would be silently written as 0, and "absent != 0" is a hard invariant (FR-006); with it, the
 * column's own Nullable(Float32) keeps the NULL.
 */

const SAVED_SITES_TABLE = "app.saved_sites";

async function chInsert(env: Env, row: Record<string, unknown>): Promise<void> {
  const params = new URLSearchParams({
    query: `INSERT INTO ${SAVED_SITES_TABLE} FORMAT JSONEachRow`,
    // A null must stay null, not fall back to the column default. See the module note above.
    input_format_null_as_default: "0",
  });
  const res = await fetch(`${env.CLICKHOUSE_URL}/?${params}`, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": env.CLICKHOUSE_APP_WRITER_USER,
      "X-ClickHouse-Key": env.CLICKHOUSE_APP_WRITER_PASSWORD,
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`clickhouse insert failed: HTTP ${res.status} ${await res.text()}`);
  }
}

export async function handleSaveSite(request: Request, env: Env): Promise<Response> {
  const input = (await request.json()) as {
    // Accepted for wire compatibility with the existing client call, and ignored. A saved site is
    // keyed on (user_id, city, business_type) only — there is no per-chat scoping on either save
    // path; see the `insertSavedSite` note in web/src/trigger/chat.ts.
    chatId?: string;
    city: string;
    category: string;
    label: string;
    lon: number;
    lat: number;
    h3_8: string;
    score?: number | null;
  };

  // Generated here, not defaulted by the column, because the response hands it back to the browser
  // for its optimistic row before the next read runs.
  const id = crypto.randomUUID();

  try {
    await chInsert(env, {
      id,
      user_id: "u1",
      city: input.city,
      // The trade word the user typed — the same string the agent's saveSite persists and
      // compareSavedSites matches on by equality.
      business_type: input.category,
      label: input.label,
      lon: input.lon,
      lat: input.lat,
      h3_8: input.h3_8,
      score: input.score ?? null,
      status: "candidate",
    });
    return json(request, env, { ok: true, id });
  } catch (err) {
    return json(
      request,
      env,
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
