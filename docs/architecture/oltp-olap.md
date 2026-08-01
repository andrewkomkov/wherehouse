# ADR-004: Postgres (OLTP) → CDC → ClickHouse (OLAP)

**Status:** SUPERSEDED by [ADR-005](saved-sites-in-clickhouse.md), 2026-08-01 — built,
verified end-to-end and shipped 2026-07-17; the Postgres instance and the CDC pipe were
deleted once the hackathon closed.
**Date:** 2026-07-17

> **This describes what we ran during the hackathon, not what runs now.** The reasoning below
> stands on its own — it is why the OLTP+OLAP split was the right call *for a workspace with a
> bonus prize attached to it*. What changed afterwards is the cost side, not the argument:
> five saved rows did not justify a Postgres instance, a CDC pipe and a Cloudflare Hyperdrive
> config (the only way a Worker could validate that server's private CA). ADR-005 moves the
> saved sites into ClickHouse itself and keeps the join that this ADR exists for. Read this one
> for the CDC facts (they were all verified live, and are still true of ClickPipes); read
> ADR-005 for what the code does today.

## Why

Two reasons, in order of honesty:

1. **The product genuinely needs it.** Without a transactional store, WhereHouse is a
   stateless calculator: ask once, get a map, close the tab. With one, it's a workspace
   you come back to. ClickHouse is bad at exactly what a workspace needs — mutate one
   row, rename it, delete it, attach a note, and see it immediately. `ReplacingMergeTree`
   dedupes eventually; mutations are async. Postgres does this natively.
2. **There's a prize for it.** The hackathon has a bonus category — *best OLTP + OLAP
   integration* — with its own prize and less competition. The rules also say, verbatim:
   *"Postgres managed by ClickHouse optional addition."* That's a signpost.

## What we built (all via the Cloud REST API — no console clicking)

```
Postgres 18.4 (ClickHouse-managed, eu-west-1)
   │  wal_level=logical, publication wherehouse_pub
   ▼  ClickPipes CDC (PeerDB), syncIntervalSeconds=10
ClickHouse Cloud 26.4 → oltp.pg_shortlists / oltp.pg_saved_sites (ReplacingMergeTree)
   │
   └── JOIN against 75M Overture POIs on S3
```

- **Managed Postgres** `wherehouse-oltp`, pg18, `c6gd.large`, eu-west-1, `haType: none`.
  Created via `POST /v1/organizations/{org}/postgres`. It is literally
  `*.aws.pg.clickhouse.cloud` — "Postgres managed by ClickHouse", exactly as the rules word it.
- **ClickPipe** `wherehouse-pg-cdc`, `replicationMode: cdc`, `publicationName: wherehouse_pub`,
  targets `ReplacingMergeTree`. Created via
  `POST /v1/organizations/{org}/services/{svc}/clickpipes`.
- Schema: `db/postgres/001_oltp_schema.sql` — deleted with the instance; see `git log` if the
  DDL is ever needed again.

## Verified facts

- **CDC prerequisites are pre-configured.** The managed Postgres ships `wal_level=logical`,
  `max_replication_slots=10`, and `rolreplication=t` on the `postgres` role. Nothing to tune.
- **End-to-end latency ~20 s** at `syncIntervalSeconds=10`: an `INSERT` in Postgres
  appeared in `oltp.pg_saved_sites` on the second poll.
- **PeerDB under the hood** — the pipe also creates
  `_peerdb_raw_mirror_<pipeid>` in the target database. Don't be surprised by it.
- Postgres needs **`REPLICA IDENTITY FULL`** on replicated tables so UPDATE/DELETE ship
  before-images. Set in the schema file.
- **TLS: `sslmode=require` is not enough for `psql`** — the server cert is Ubicloud-issued
  and fails default verification. Fetch the CA from
  `GET /v1/organizations/{org}/postgres/{id}/caCertificates` (returns **raw PEM, not JSON**)
  and use `sslmode=verify-full&sslrootcert=…`. The same PEM goes into the ClickPipe's
  `caCertificate` field.

## The query this exists for

A user's saved site — written to Postgres seconds ago — joined against the global
Overture places parquet on S3. **Verified output:**

```sql
SELECT s.label, s.status, round(s.score,2) AS your_score,
       countIf(p.categories.primary='bakery') AS bakeries_within_500m,
       countIf(p.categories.primary='cafe')   AS cafes_within_500m,
       round(min(if(p.categories.primary='bakery',
                geoDistance(s.lon,s.lat,p.geometry.1,p.geometry.2), null))) AS nearest_bakery_m
FROM oltp.pg_saved_sites AS s
INNER JOIN (
  SELECT geometry, categories FROM s3('…/theme=places/type=place/*.parquet','Parquet')
  WHERE bbox.xmin BETWEEN 13.088 AND 13.761 AND bbox.ymin BETWEEN 52.338 AND 52.675
    AND categories.primary IN ('bakery','cafe')
) AS p ON 1=1
WHERE geoDistance(s.lon,s.lat,p.geometry.1,p.geometry.2) <= 500
GROUP BY s.label, s.status, your_score
```
```
site: Kastanienallee corner | status: shortlisted | your_score: 0.87
bakeries_within_500m: 5 | cafes_within_500m: 39 | nearest_bakery_m: 225
```

**This join is the entire argument.** Without CDC there is nowhere to perform it: you
cannot pull 75M rows into JS to join five of the user's points, and you cannot keep the
user's mutable workspace in ClickHouse. OLTP and OLAP each do the half they're good at.

For production the `ON 1=1` + `WHERE geoDistance` cross join must become an H3 k-ring
join (`WHERE p.h3_8 IN h3kRing(s.h3_8, 1)`) against a local `places` table — see
[ADR-002](data-sources.md). The form above is the demo-scale proof.

## ⚠️ Operational lesson, learned the hard way on day 1

Hours after building this, ClickHouse emailed: *"ClickPipe wherehouse-pg-cdc is currently
degraded … due to missing replication slot."*

**Cause:** we tried to downsize the Postgres via `PATCH /postgres/{id}` `{"size": …}`.
That call returns `200`, echoes back the **old** size, and never resizes — but it **does
restart the instance**. The restart dropped the replication slot, because the pipe setting
`enableFailoverSlots` defaults to `false`. Calling it a "silent no-op" was wrong: it's
worse than a no-op, it silently breaks CDC.

**The pipe's own `state` field said `Running` throughout.** It lies. The email alert was
the only honest signal. Diagnose with Postgres, not the pipe:

```sql
SELECT * FROM pg_replication_slots;        -- empty = broken
SELECT pg_postmaster_start_time();         -- recent = it restarted
```

**Fix** — `PATCH /clickpipes/{id}/state {"command":"resync"}`. Recreates the slot
(`peerflow_slot_mirror_<id>`, plugin `pgoutput`) and re-snapshots; ~30 s at our volume.
Then verify with a canary INSERT — do not trust the state field.

**Rules:** never touch Postgres `size` (resize = delete + recreate). Any Postgres restart
means checking the slot. Consider `enableFailoverSlots: true` if we ever restart on purpose.

## Product surface this unlocks

- **Portfolio**: saved sites are editable first-class objects, not query output.
- **"Your sites vs the market"**: the query above, as a chat answer.
- **Timeline for free**: CDC *is* a changelog. Every edit lands in ClickHouse with a
  timestamp ⇒ "how did my shortlist's score move as I tuned the weights?" is a chart —
  i.e. another *visual* answer, straight at the hackathon theme.
- **Monitoring**: a scheduled Trigger.dev task re-scores saved sites as Overture updates
  → *"a bakery opened 200 m from site #3; score −12"*. This is Trigger.dev's second
  meaningful role beyond the chat, which matters for the 25% criterion.

## Honest cost

The core demo (map, isochrones, scoring) does **not** need any of this — it's pure
ClickHouse. This is a superstructure: one more moving part, one more thing that can break
on stage. We're taking it because it's a separate prize, it's the architecturally correct
answer rather than a checkbox, and it follows from the product rather than the reverse.

Running cost: one `c6gd.large` Postgres + one ClickPipe for ~6 days, against $400 of
credits. Comfortable.

## Cleanup (done, 2026-08-01)

The five live saved sites were copied into `app.saved_sites` (ADR-005) and read back before
anything was deleted; then, in this order:

```bash
DELETE /v1/organizations/{org}/services/{svc}/clickpipes/{pipeId}   # pipe first — it holds the slot
DELETE /v1/organizations/{org}/postgres/{postgresId}
wrangler hyperdrive delete wherehouse-pg-hyperdrive                 # Worker's only route to it
wrangler cert delete --id <wherehouse-pg-ca>
DROP DATABASE oltp                                                  # the CDC target + PeerDB raw table
```
