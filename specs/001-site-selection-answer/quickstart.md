# Quickstart — validating the answer flow

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

How to prove the feature works. The **exit gate** is behavioural and observed in a browser —
there is no unit-test harness in this project and day 3 does not add one (constitution VI).

## Prerequisites

```sh
./infra/check-env.sh          # ~5s, verifies every credential against the live services
```

Expect `8 ok, 0 broken`. Two things this catches:

- **`POSTGRES_URL` must stay quoted in `.env`** — an unquoted `&` aborts `source .env` and
  silently drops every line below it.
- **The ClickHouse service idles after 15 min.** The first query wakes it and may be slow. A
  single timeout is not an outage — re-run before diagnosing.

Also check the **DeepSeek balance** line. It was **$4.87** on 19 July; that is enough for a
day of iteration, not a week of demos. To fall back to real Anthropic, drop
`ANTHROPIC_BASE_URL`.

## Setup

```sh
./infra/load-layers.sh        # creates web.layers (idempotent). No access DDL — by design.
cd web && pnpm dev            # terminal 1
pnpm exec trigger dev         # terminal 2
```

## The exit gate

Ask, in the chat:

> where should I open a bakery in Berlin?

**Pass conditions** — all must hold:

1. **Three layers on one map**: competitor dots, a GAP choropleth, exactly three ranked pins.
2. **They arrive as their work completes**, not in one batch at the end (FR-002).
3. **The run does not fail.** In particular the choropleth (549 KiB) crosses the 256 KiB
   budget and takes the handle path — watch the network tab for a `GET` to ClickHouse
   returning the GeoJSON, and confirm no `ChatChunkTooLargeError` in the Trigger.dev run log.
4. **The text is at most two sentences** and never narrates coordinates (SC-006).
5. **Kontur attribution is visible** (FR-017 — licence obligation).
6. **The answer names no districts.** See below — this is the one that actually failed.
7. ~~Reload the page: the map is still there.~~ **Cut** — a reload starts a fresh session. It
   was tested, found false, and descoped rather than left as an unverified claim. See the
   spec's Out of Scope table.

### The failure this gate is really for is the prose, not the map

On the first live run the map was correct and the sentence said all three picks were in
**Spandau** — the opposite side of Berlin from where the pins actually were. The tools return
`gap`/`population`/`competitor count` and **no place names**, so asked to name an area the
model invented one that sounded right. A confident, checkable, wrong claim is worse than
saying less, and it is exactly what a Berlin-literate judge would catch first.

The system prompt now forbids naming any district, neighbourhood or street. **If you ever see
a place name in the answer, that guard has regressed** — the map may still be right, but the
answer is no longer trustworthy. Expected shape of a good answer:

> Each of the three top spots sits in an underserved area with no nearby competitors,
> serving between 5,860 and 6,826 people. The map shows where they are.

## Verifying the answer is defensible, not just pretty

This is the point of the whole feature — check it rather than admiring it.

**Hand-verify a pick (SC-004).** Each pin shows its population and ring competitor count. The
baseline from 19 July, Berlin bakeries:

| Rank | Area | People | Bakeries in ring | gap |
|---|---|---|---|---|
| 1 | Mariendorf (`881f18b021fffff`) | 6,826 | 0 | 100.0 |
| 2 | Hellersdorf/Kaulsdorf (`881f1d4d81fffff`) | 6,807 | 0 | 100.0 |
| 3 | Köpenick (`881f18b645fffff`) | 5,860 | 0 | 100.0 |

Dense residential, no bakeries nearby — and notably **not** the commercial centre, which is
where a POI-density demand proxy would have pointed. If the top-3 lands on Mitte, the demand
term has regressed to a proxy and the answer is no longer defensible.

**Determinism (SC-005).** Ask the same question twice; the top-3 must be identical in the
same order. Ties at the p95 clamp are real (three cells at exactly 100.0), which is why the
`cell ASC` tiebreak exists.

**Sanity-check the score directly**, bypassing the agent:

```sh
set -a && . ./.env && set +a
curl -s --user "default:$CLICKHOUSE_PASSWORD" "$CLICKHOUSE_URL/" --data-binary @- <<'SQL'
WITH
  cells AS (
    SELECT h3_8, population FROM geo.population
    WHERE country = 'DE'
      AND h3ToGeo(h3_8).1 BETWEEN 52.338 AND 52.675   -- .1 is LAT — H3 is lat-first
      AND h3ToGeo(h3_8).2 BETWEEN 13.088 AND 13.761   -- .2 is LON
  ),
  supply AS (
    SELECT arrayJoin(h3kRing(h3_8, 1)) AS cell, count() AS n
    FROM geo.places WHERE city = 'berlin' AND category = 'bakery' GROUP BY cell
  ),
  joined AS (
    SELECT c.h3_8 AS cell, c.population AS pop, coalesce(s.n, 0) AS sup
    FROM cells c LEFT JOIN supply s ON c.h3_8 = s.cell
  ),
  scale AS (
    SELECT quantile(0.95)(pop) AS pop_p95, greatest(quantile(0.95)(sup), 1) AS sup_p95
    FROM joined
  )
SELECT h3ToString(cell) AS h3, round(pop) AS pop, sup,
       round(least(100, 100*pop/pop_p95) * (100 - least(100, 100*sup/sup_p95)) / 100, 1) AS gap
FROM joined, scale
ORDER BY gap DESC, pop DESC, cell ASC
LIMIT 3
FORMAT PrettyCompact
SQL
```

Must reproduce the table above. If the agent's pins disagree with this query, the agent is
wrong — this SQL is the reference.

## Testing the 1 MiB path on purpose (User Story 2)

> show me every restaurant in Berlin

The widest layer in the data is every Berlin POI at **14.9 MiB — 14× the cap**. The run must
still complete and the map must still render (SC-003, FR-011).

## Traps that will waste your time here

- **A CORS check with plain `curl` shows no CORS headers.** That is correct behaviour, not a
  bug: ClickHouse echoes them only when the request carries `Origin`. Use
  `-H "Origin: http://localhost:3000"`. Nearly cost a redesign in Phase 0.
- **Never pass `add_http_cors_header=1`** — `readonly=1` forbids setting modification and it
  returns HTTP 500 for `site`. It is unnecessary anyway.
- **An empty map with no error usually means a swapped lat/lon.** The whole H3 family is
  lat-first (`geoToH3`, `h3ToGeo`, `h3ToGeoBoundary`), while every other geo function is
  lon-first, and GeoJSON wants `[lon, lat]`. A bbox filter with the tuple elements swapped
  returns **zero rows and no error**.
- **Never run access DDL** (`CREATE USER` / `CREATE SETTINGS PROFILE`) to fix a permission
  problem here. You do not need any: `GRANT SELECT ON web.*` already covers `web.layers`.
  `p_html`/`web_html`/`web_html2` are permanently wedged from exactly that instinct.
</content>
