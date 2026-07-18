# wherehouse-app worker

Serves the WhereHouse Next.js static export out of ClickHouse (`web.assets`, one row per
file) and fronts the three server-side operations the static export has no runtime for.

Live: <https://app.slim-shaggy.com>

Don't deploy this by hand — `./infra/deploy-app.sh` owns the whole pipeline (build the
static export → load it into `web.assets` → provision the Cloudflare CA cert + Hyperdrive
config if missing → `wrangler deploy` + secrets → live verify) and is idempotent.

## Why this exists

The app used to be a normal Next.js server (Server Actions in `web/src/app/actions.ts`
for auth + Postgres). `next.config.ts` now sets `output: "export"`, which produces a fully
static `web/out/` with **zero server runtime** — the whole point, so it can ship as
ClickHouse rows (ADR-003). That leaves three operations with nowhere to run:

1. **Mint a Trigger.dev public token** (`/api/token`) and **start a chat session**
   (`/api/start-session`) — `@trigger.dev/sdk`'s `auth.createPublicToken` and
   `@trigger.dev/sdk/ai`'s `chat.createStartSessionAction`. Both are pure `fetch` +
   local HS256 JWT signing (`jose`, WebCrypto-based) under the hood — no raw TCP.
   Verified to run in workerd (both `wrangler dev` locally and a real deployed Worker)
   *before* any of this was built.

2. **Save / list a site** (`/api/save-site`, `/api/list-saved`) — plain `pg` queries
   against the managed Postgres, via a **Hyperdrive** binding, not `cloudflare:sockets`
   directly. See below.

## Why Hyperdrive, not raw Workers TCP sockets

Verified before writing any of this code: `pg` has first-class Cloudflare Workers support
(`pg-cloudflare`, using `cloudflare:sockets`' `secureTransport: "starttls"`). A raw socket
completes the TCP connection and the Postgres SSLRequest handshake fine (server replies
`S` — SSL supported), but the TLS upgrade closes itself asynchronously about a second
later, before the StartupMessage can be sent. Root cause, confirmed with a manual
`connect()` + `startTls()` probe: **Cloudflare's Sockets API validates `startTls()` only
against the public root CA store, with no option to supply a custom CA** — and our
managed Postgres presents a private, Ubicloud-issued CA (the exact same root cause as the
documented `psql sslmode=require` failure in `CLAUDE.md`).

**Hyperdrive supports a custom CA** (`wrangler hyperdrive create --ca-certificate-id`,
the cert uploaded separately via `wrangler cert upload certificate-authority`) and this
was verified end-to-end on a real deployed Worker: bound via `env.HYPERDRIVE`, a plain
`pg.Client({ connectionString: env.HYPERDRIVE.connectionString })` returned real
`saved_sites` rows on 4/4 requests.

**Gotcha, cost real time diagnosing:** `.secrets/pg-ca.crt` holds **two** root certs — an
old/new pair, both still validity-window-valid — and only one of them actually signs the
live Postgres leaf certificate. Uploading the wrong one (or the file as-is, concatenated)
makes Hyperdrive fail *at config-creation time* with `TLS handshake failed: cert
verification failed - certificate signature failure [BAD_SIGNATURE]`, which reads like a
bad/expired CA when it's actually the wrong (but real) root. `infra/deploy-app.sh`'s
`resolve_correct_ca` picks the right one the same way this was diagnosed: fetch the live
leaf cert with `openssl s_client -starttls postgres -showcerts`, then `openssl verify`
each candidate root against it.

## Routes

| Route | Method | What |
|---|---|---|
| `/` and any other path | GET | Static asset out of `web.assets` (ClickHouse), `/` → `/index.html`, unknown paths → `404.html` |
| `/api/token` | POST `{chatId}` | Mint a Trigger.dev public token |
| `/api/start-session` | POST `{chatId, clientData?}` | Start (or resume) a `chat.agent` session |
| `/api/save-site` | POST | Insert a saved site (find-or-create the shortlist) |
| `/api/list-saved` | GET `?city=` | List the demo user's saved sites |

## Cloudflare resources this depends on (provisioned by `infra/deploy-app.sh`, idempotent by name)

- CA cert `wherehouse-pg-ca` (`wrangler cert list`)
- Hyperdrive config `wherehouse-pg-hyperdrive`, bound as `HYPERDRIVE` (`wrangler hyperdrive list`)
- Worker secrets `TRIGGER_SECRET_KEY`, `CLICKHOUSE_SITE_PASSWORD` (`wrangler secret list`)
- Custom domain route `app.slim-shaggy.com` (declared in `wrangler.toml`)

## Local dev

`web/src/lib/api-client.ts` always calls the ONE deployed Worker
(`NEXT_PUBLIC_API_BASE_URL`), in both `next dev` and production — there is no local
mock/proxy of these routes. This means `next dev` needs the Worker to be live (it is) and,
for the chat to actually *run* (not just start a session), a local `pnpm exec trigger dev`
process, since the project's `TRIGGER_SECRET_KEY` is a `tr_dev_…` (dev environment) key —
there is no deployed Trigger.dev staging/prod environment yet.

`wrangler dev` against this worker directly needs a **local** Postgres connection string
for the Hyperdrive binding (Cloudflare's local-dev emulation, not the real Hyperdrive
proxy) — `wrangler dev` will tell you so if you try. Prefer testing against the real
deployed Worker (`./infra/deploy-app.sh verify`) over local `wrangler dev` for this
package.
