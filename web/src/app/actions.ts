"use server";

import { auth } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";

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
