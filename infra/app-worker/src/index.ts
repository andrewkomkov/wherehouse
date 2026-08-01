import type { Env } from "./env";
import { preflight } from "./cors";
import { serveAsset } from "./assets";
import { handleToken, handleStartSession } from "./trigger-auth";
import { handleSaveSite } from "./saved-sites";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pre = preflight(request, env);
    if (pre) return pre;

    const url = new URL(request.url);

    if (url.pathname === "/api/token" && request.method === "POST") {
      return handleToken(request, env);
    }
    if (url.pathname === "/api/start-session" && request.method === "POST") {
      return handleStartSession(request, env);
    }
    // Writes only. The saved-list READ is browser-direct to ClickHouse as the read-only `site`
    // user (chat.tsx::fetchSavedSitesFromClickHouse) — `/api/list-saved` existed because the list
    // used to live in Postgres, and had no caller left once it didn't.
    if (url.pathname === "/api/save-site" && request.method === "POST") {
      return handleSaveSite(request, env);
    }

    // Everything else is the static bundle, served out of ClickHouse (`web.assets`).
    return serveAsset(request, env, ctx);
  },
};
