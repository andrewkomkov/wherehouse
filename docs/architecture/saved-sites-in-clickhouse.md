# ADR-005: saved sites live in ClickHouse; Postgres and CDC are retired

**Status:** ACCEPTED — built, verified against the live system and deployed, 2026-08-01
**Supersedes:** [ADR-004](oltp-olap.md)
**Date:** 2026-08-01

## Context

[ADR-004](oltp-olap.md) put the user's workspace — saved sites — in a ClickHouse-managed
Postgres and replicated it back into ClickHouse with a ClickPipes CDC pipe, so a
seconds-old saved site could be joined against 75M Overture POIs. It worked, it was the
architecturally correct answer for a mutable workspace, and it targeted the hackathon's
OLTP+OLAP bonus prize.

The hackathon is over. What that decision leaves behind, in steady state:

| Moving part | Why it existed |
|---|---|
| Managed Postgres `wherehouse-oltp` (`c6gd.large`) | the transactional store |
| ClickPipe `wherehouse-pg-cdc` | replicate it back for the join |
| ClickHouse database `oltp` + a PeerDB raw mirror table | the CDC target |
| Cloudflare Hyperdrive config + an uploaded CA certificate | the *only* way a Worker could reach that Postgres — raw `cloudflare:sockets` cannot validate its private Ubicloud CA |
| `.secrets/pg-ca.crt`, `POSTGRES_CA_CERT` in the Trigger prod env, four `POSTGRES_*` vars in `.env` | TLS for the two runtimes |
| A CI job running a real `postgres:18-alpine` to assert the publication exists | CDC breaks silently without it |

That is six things to keep alive, in three providers, holding **five rows**. Each has bitten
us at least once: the pipe's `state` field reporting `Running` with a dead replication slot;
`allowNullableColumns: false` silently turning a NULL score into `0.0` (against a hard project
invariant) and not being PATCH-able afterwards; the CA bundle containing two valid roots of
which only one signs the live leaf; `web/src/lib/pg.ts` reading the CA at module load and
crashing `trigger deploy`'s indexer.

## Decision

**ClickHouse is the only store.** One table, `app.saved_sites`
([`db/clickhouse/014_saved_sites.sql`](../../db/clickhouse/014_saved_sites.sql)),
`ReplacingMergeTree(updated_at)`, read with `FINAL`. Postgres, the CDC pipe, the `oltp`
database, the Hyperdrive config and the uploaded CA cert are deleted.

```
                  agent tool  saveSite  ─┐   (Trigger.dev task, `default` client)
                                         ├──▶  app.saved_sites  ──▶  browser reads it
POST /api/save-site (Cloudflare Worker) ─┘        (ClickHouse)        as the public
        as the narrow `app_writer` user                               read-only `site` user
```

- **Writes** need a credential the browser must not hold, so the map-click save still goes
  through the Worker. It authenticates as `app_writer`: `GRANT INSERT, SELECT ON
  app.saved_sites` — that table and nothing else (verified: `SELECT count() FROM geo.places`
  as this user returns `497 ACCESS_DENIED`). The `default` password stays out of the Worker.
  The agent's `saveSite` tool writes with the same `default` client it already uses for
  `web.layers`.
- **Reads** are browser-direct to ClickHouse, the same posture as every other layer
  (ADR-003), via `GRANT SELECT ON app.saved_sites TO site`.
- **One table, not two.** `shortlists` existed to hang `(city, business_type)` off a save;
  both are columns now. `shortlist_id` was never rendered anywhere — it only fed that JOIN.
  With the shortlist row gone, so is the `SAVE_CHAT_SCOPE` constant both save paths had to
  agree on to stop one trade's shortlist splitting in two.

## What this trades away

Honestly: the thing ADR-004 was right about. ClickHouse is still bad at single-row mutation —
an edit is a new version plus a `FINAL` on read, a delete is an async mutation. **We do not
mutate saved sites.** Both save paths only ever INSERT, and nothing in the product edits or
deletes a saved site. The engine is `ReplacingMergeTree` rather than plain `MergeTree` so that
when something does, the read path already collapses versions instead of showing both. If a
real edit/delete surface is ever built — notes, statuses, a "remove" button — this decision
should be revisited, not worked around.

The OLTP+OLAP *join* is not lost, and that was always the interesting half: a user's saved
site re-scored against today's market on `stringToH3(h3_8) = scored.cell` is exactly the same
query it was (`savedSitesRowsSql` / `savedSitesGeoJsonSql` in `web/src/trigger/scoring.ts`) —
one fewer JOIN, and no tombstone filters.

## Verified against the live system, not assumed

Measured 2026-08-01 on the live service (26.4.1.2029):

- **Read-after-write is immediate.** Three consecutive INSERT-then-SELECT round-trips through
  the real HTTP path: the row was visible to the next read every time (1/1, 2/2, 3/3), whole
  round-trip 611–755 ms. CDC took ~10 s at `syncIntervalSeconds=10`, which is why the client
  carried an optimistic local insert *and* a 15 s reconciling re-read; the timer is gone and
  the optimistic insert is now only a guard against the re-read racing the write.
- **`score` is genuinely nullable.** A JSON `null` written through the Worker's path lands as
  `NULL`, not `0.0` (`countIf(score IS NULL)` = `count()` on the canary rows). This needs
  `input_format_null_as_default=0` on the insert, which the Worker sets — without it ClickHouse
  substitutes the column default and silently reintroduces exactly the absent-vs-zero bug the
  ClickPipe had (FR-006: an unscored site renders "unscored", never 0).
- **Migration was verified before anything was deleted.** All 5 live saved sites were copied
  from `oltp.pg_saved_sites ⨝ oltp.pg_shortlists` into `app.saved_sites` and read back with
  labels, cities, trades, scores and timestamps intact.
- **`./infra/deploy-app.sh verify` proves the write path on every deploy** — it POSTs a canary
  row through the deployed Worker, reads it back as the *public* `site` user (so the GRANT is
  proven too, not just the INSERT), then deletes it.

## Consequences

- `db/postgres/`, `web/src/lib/pg.ts`, `infra/app-worker/src/postgres.ts` and the `pg`
  dependency in both `package.json`s are gone.
- `GET /api/list-saved` is gone. It had no caller: the panel reads ClickHouse directly.
- `infra/deploy-app.sh provision` (CA upload + Hyperdrive) is gone; `infra/provision.sh` now
  ends at the ClickHouse schema; `infra/teardown.sh` has one billable resource left to talk
  about; `check-env.sh` and `status.sh` check the store instead of the pipe.
- The CI `sql sanity` job (a real `postgres:18-alpine` service container asserting publication
  `wherehouse_pub` exists) is removed with the schema it verified.
- `.env` loses `POSTGRES_URL/HOST/USER/PASSWORD/DB` and gains
  `CLICKHOUSE_APP_WRITER_USER/PASSWORD`. `.secrets/pg-ca.crt` is no longer read by anything.
- One less thing that can be `Running` while broken.
