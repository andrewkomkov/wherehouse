"use client";

/**
 * The client-side replacement for `@/app/actions` (day 5 / ADR-003).
 *
 * The app now ships as a static export (`output: "export"` — zero server runtime, no
 * Server Actions, no API routes) so it can be served as bytes straight out of ClickHouse.
 * The operations that used to be Next.js Server Actions — mint a Trigger public token, start a
 * chat session, save a site — moved to the Cloudflare Worker that fronts the ClickHouse-served
 * bundle (`infra/app-worker/`). This module keeps the exact same function signatures the old
 * `actions.ts` exposed, so `chat.tsx` only needed an import swap.
 *
 * Reads are not here: the saved-list read goes browser-direct to ClickHouse
 * (`chat.tsx::fetchSavedSitesFromClickHouse`). Only the write needs the Worker, because it needs
 * a credential that can INSERT (ADR-005).
 *
 * `NEXT_PUBLIC_API_BASE_URL` points at the ONE deployed Worker in both `next dev` and
 * production — there is no local mock/proxy. That mirrors how `NEXT_PUBLIC_CLICKHOUSE_URL`
 * is already hit directly from the browser in dev (ADR-003's browser-direct-to-Cloud
 * pattern); it means dev and prod exercise the identical code path, not a simulation of it.
 */

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** Pure mint — the transport calls this on 401/403 to refresh. The browser never holds
 * TRIGGER_SECRET_KEY; the Worker does, and mints a fresh HS256 JWT per request. */
export async function mintChatAccessToken(chatId: string): Promise<string> {
  const res = await fetch(apiUrl("/api/token"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatId }),
  });
  if (!res.ok) {
    throw new Error(`mintChatAccessToken failed: HTTP ${res.status}`);
  }
  const { token } = (await res.json()) as { token: string };
  return token;
}

/** Creates the Session row + triggers the first run, returns the session PAT. Idempotent on
 * (env, chatId) — mirrors `chat.createStartSessionAction`'s own contract. */
export async function startChatSession(input: {
  chatId: string;
  clientData?: unknown;
}): Promise<{ publicAccessToken: string; runId: string; sessionId: string }> {
  const res = await fetch(apiUrl("/api/start-session"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`startChatSession failed: HTTP ${res.status} ${text}`);
  }
  return res.json();
}

/** Click-to-save. Returns the new `app.saved_sites` id (a UUID), or the error string on failure
 * — same contract as the old server action. */
export async function saveSiteAction(input: {
  chatId: string;
  city: string;
  category: string;
  label: string;
  lon: number;
  lat: number;
  h3_8: string;
  score?: number | null;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(apiUrl("/api/save-site"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const json = (await res.json().catch(() => ({}))) as
      | { ok: true; id: string }
      | { ok: false; error?: string };
    if (!res.ok || !json.ok) {
      return { ok: false, error: ("error" in json && json.error) || `HTTP ${res.status}` };
    }
    return json;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
