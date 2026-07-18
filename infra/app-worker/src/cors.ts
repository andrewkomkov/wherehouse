import type { Env } from "./env";

/**
 * The page and the API are served from the same worker/domain in production
 * (`app.slim-shaggy.com`), so most calls are same-origin and need no CORS at all. This
 * exists for `next dev` (`http://localhost:3000`) calling out to the one deployed Worker —
 * see `web/src/lib/api-client.ts`'s doc comment for why there is no local mock.
 */
export function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  const headers: Record<string, string> = {
    Vary: "Origin",
  };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "content-type";
  }
  return headers;
}

export function preflight(request: Request, env: Env): Response | null {
  if (request.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

export function json(
  request: Request,
  env: Env,
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
  return new Response(JSON.stringify(body), { ...init, headers });
}
