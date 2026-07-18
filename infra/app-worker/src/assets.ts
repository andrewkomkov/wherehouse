import type { Env } from "./env";

/**
 * Serves the static Next export out of ClickHouse (`web.assets`, one row per file) — the
 * actual ADR-003 claim: every byte the browser receives for the page originates in a
 * ClickHouse `MergeTree` row, not a filesystem or an object store. This Worker's only job
 * on the asset path is to read those bytes back out and attach the right headers; it is not
 * where the content-type stunt (`http_response_headers`) lives — that would only matter if
 * the BROWSER queried ClickHouse directly, and here the Worker does, with its own
 * credentials, so it just sets `Content-Type` itself from the stored `content_type` column.
 *
 * Uses the existing public read-only `site` user (readonly=1, `GRANT SELECT ON web.*`) —
 * server-side use of an already-public, already-safe credential. No new ClickHouse access
 * DDL was needed for this table; see db/clickhouse/009_app_assets_schema.sql.
 *
 * Two round trips per uncached path (content_type, then raw bytes) rather than one,
 * because ClickHouse's JSON-ish formats can't carry arbitrary binary (woff2, etc.)
 * losslessly, and `RawBLOB` only carries a single column safely. Cloudflare's edge cache
 * (`caches.default`) makes the second request rare after the first hit.
 */

async function chQuery(env: Env, sql: string, params: Record<string, string>): Promise<Response> {
  const url = new URL(env.CLICKHOUSE_URL);
  url.searchParams.set("user", env.CLICKHOUSE_SITE_USER);
  url.searchParams.set("password", env.CLICKHOUSE_SITE_PASSWORD);
  url.searchParams.set("query", sql);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, v);
  return fetch(url.toString());
}

function normalizePath(pathname: string): string {
  // Decode %-escapes so a request for a stored path with spaces resolves — e.g. the vendored
  // map glyphs land in web.assets as `/basemaps-assets/fonts/Noto Sans Regular/0-255.pbf`, but
  // MapLibre requests them URL-encoded (`Noto%20Sans%20Regular`). No-op for ordinary paths.
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    // Malformed escape — fall back to the raw path rather than throwing.
  }
  if (p === "/" || p === "") return "/index.html";
  return p;
}

export async function serveAsset(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  const metaRes = await chQuery(
    env,
    "SELECT content_type FROM web.assets FINAL WHERE path = {path:String} FORMAT TSVRaw",
    { path },
  );
  if (!metaRes.ok) {
    return new Response("ClickHouse asset lookup failed", { status: 502 });
  }
  const contentType = (await metaRes.text()).trim();
  if (!contentType) {
    // The static export always has a 404.html — serve it instead of a bare 404 so the
    // "served out of ClickHouse" claim holds even for the not-found page.
    if (path !== "/404.html") {
      const notFound = await serveAsset(
        new Request(new URL("/404.html", url), request),
        env,
        ctx,
      );
      return new Response(notFound.body, { status: 404, headers: notFound.headers });
    }
    return new Response("not found", { status: 404 });
  }

  const bodyRes = await chQuery(
    env,
    "SELECT body FROM web.assets FINAL WHERE path = {path:String} FORMAT RawBLOB",
    { path },
  );
  if (!bodyRes.ok || !bodyRes.body) {
    return new Response("ClickHouse asset fetch failed", { status: 502 });
  }

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  // Hashed Next assets (`/_next/static/...`) are immutable; everything else (index.html,
  // fonts, favicon) gets a short cache so a redeploy shows up without waiting a day.
  headers.set(
    "Cache-Control",
    path.startsWith("/_next/static/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300",
  );

  const response = new Response(await bodyRes.arrayBuffer(), { headers, status: 200 });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}
