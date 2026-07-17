"use server";

import { auth } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import {
  upsertShortlist,
  insertSavedSite,
  listSavedSites,
  type SavedSiteRow,
} from "@/lib/pg";

// Creates the Session row + triggers the first run, returns the session PAT.
// Idempotent on (env, chatId).
export const startChatSession = chat.createStartSessionAction("wherehouse-chat");

// Pure mint — the transport calls this on 401/403 to refresh. The browser never
// holds TRIGGER_SECRET_KEY.
export async function mintChatAccessToken(chatId: string) {
  return auth.createPublicToken({
    scopes: {
      read: { sessions: chatId },
      write: { sessions: chatId },
    },
    expirationTime: "1h",
  });
}

// Click-to-save. The client hands back the pick it is already showing — the agent's own
// layer produced these props, so we trust them here rather than re-deriving lon/lat/h3_8.
// `score` MAY be null and stays null (absent != 0 — an unscored save renders "unscored").
// One demo user for now (`u1`); the shortlist is find-or-created so repeated saves in a chat
// share one. Returns the new saved_site id, or the error string on failure.
export async function saveSiteAction(input: {
  chatId: string;
  city: string;
  category: string;
  label: string;
  lon: number;
  lat: number;
  h3_8: string;
  score?: number | null;
}): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  try {
    const shortlistId = await upsertShortlist({
      chatId: input.chatId,
      userId: "u1",
      city: input.city,
      businessType: input.category,
      title: input.label,
    });
    const { id } = await insertSavedSite({
      shortlistId,
      userId: "u1",
      label: input.label,
      lon: input.lon,
      lat: input.lat,
      h3_8: input.h3_8,
      score: input.score ?? null,
    });
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// The panel's initial render. Postgres is authoritative, so the newest save is visible with
// no CDC wait. Optional `city` narrows to one city's saves.
export async function listSavedSitesAction(city?: string): Promise<SavedSiteRow[]> {
  return listSavedSites("u1", city);
}
