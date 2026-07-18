import type { Env } from "./env";
import { preflight } from "./cors";
import { serveAsset } from "./assets";
import { handleToken, handleStartSession } from "./trigger-auth";
import { handleSaveSite, handleListSaved } from "./postgres";

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
    if (url.pathname === "/api/save-site" && request.method === "POST") {
      return handleSaveSite(request, env);
    }
    if (url.pathname === "/api/list-saved" && request.method === "GET") {
      return handleListSaved(request, env);
    }

    // Everything else is the static bundle, served out of ClickHouse (`web.assets`).
    return serveAsset(request, env, ctx);
  },
};
