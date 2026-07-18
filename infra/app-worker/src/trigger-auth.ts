import type { Env } from "./env";
import { json } from "./cors";

/**
 * The two Trigger.dev server-side operations, moved out of Next's `actions.ts` (Server
 * Actions don't exist in a static export) and proven to run in workerd before anything else
 * was built — see the linchpin proof in the day-5 report. Both are pure `fetch` + local
 * HS256 JWT signing (via `jose`, WebCrypto-based) under the hood — no raw TCP, unlike the
 * Postgres path.
 *
 * `@trigger.dev/sdk/ai`'s `chat.createStartSessionAction` needs the `ai` + `zod` peer deps
 * bundled too (`Could not resolve "ai"` otherwise) — see package.json.
 */

export async function handleToken(request: Request, env: Env): Promise<Response> {
  const { auth } = await import("@trigger.dev/sdk");
  const { chatId } = (await request.json()) as { chatId?: string };
  if (!chatId) return json(request, env, { error: "chatId is required" }, { status: 400 });

  auth.configure({ accessToken: env.TRIGGER_SECRET_KEY });
  const token = await auth.createPublicToken({
    scopes: { read: { sessions: chatId }, write: { sessions: chatId } },
    expirationTime: "1h",
  });
  return json(request, env, { token });
}

export async function handleStartSession(request: Request, env: Env): Promise<Response> {
  const { auth } = await import("@trigger.dev/sdk");
  const { chat } = await import("@trigger.dev/sdk/ai");
  const body = (await request.json()) as { chatId?: string; clientData?: unknown };
  if (!body.chatId) {
    return json(request, env, { error: "chatId is required" }, { status: 400 });
  }

  auth.configure({ accessToken: env.TRIGGER_SECRET_KEY });
  const start = chat.createStartSessionAction(env.TRIGGER_TASK_ID);
  try {
    const result = await start({ chatId: body.chatId, clientData: body.clientData });
    return json(request, env, result);
  } catch (err) {
    return json(
      request,
      env,
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
