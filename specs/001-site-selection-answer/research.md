# Phase 0 — Research: the site-selection answer flow

**Date**: 2026-07-19 · **Spec**: [spec.md](./spec.md)

Everything here was **executed against the live service** (constitution II). No claim below
rests on documentation. Where a doc or an existing ADR said otherwise, the executed result
wins and the delta is called out.

---

## R1 — Does the by-reference (handle) path actually work end to end?

**This is the riskiest thing in the plan** (constitution III), because the whole 1 MiB
mitigation rests on it and none of it had ever been run: the spec assumed it from ADR-003's
component parts. So it was run, with the **real 549 KiB choropleth**, not a toy.

**Decision: proven — the browser reads a real layer straight out of ClickHouse.**

| Step | Actor | Measured |
|---|---|---|
| `INSERT` 549 KiB GeoJSON into a `web.*` table | `default` (the task) | **770 ms** |
| `GET ?query=…` with `Origin`, readonly user | `site` (the browser) | **550 ms** |
| Round-trip fidelity | — | **byte-identical**, 2,260 cells |

Handle overhead ≈ **1.3 s** total, comfortably inside SC-002's 15 s.

**Rationale**: no new datastore, and it turns the constraint into the ADR-003 stunt — on
stage the browser talks to ClickHouse directly, which *strengthens* the 25% "use of
ClickHouse" criterion instead of working around it.

**Alternatives considered**:
- *Chunking the layer across several stream records* — rejected: complexity in the client,
  still capped, and it buys nothing the handle doesn't.
- *Downsampling wide layers to fit* — rejected: it makes the map lie.
- *A Cloudflare R2 / KV blob store* — rejected: new infrastructure (constitution IV) for a
  job ClickHouse already does, and it would put a non-ClickHouse box in the data path.

## R2 — Does the handle path need access DDL? **No — and this matters**

`SHOW GRANTS FOR site` → `GRANT SELECT ON web.* TO site`.

The grant is a **wildcard over the whole `web` database**. Verified by canary: a brand-new
`web.canary_grant` table, created after the grant existed, was read by `site` with **no GRANT
issued for it**.

**Decision: put the layer store in `web.*` and issue no access DDL at all.**

This is not a convenience — it is the mitigation for **trap #4**. `p_html` / `web_html` /
`web_html2` are already permanently wedged from running access DDL during a version upgrade,
and that class of failure is unrecoverable without support. A design that needs zero
`CREATE USER` / `CREATE SETTINGS PROFILE` cannot step on that mine. The existing
`site` + `web_profile` (`readonly=1`, storage `replicated`) is used exactly as-is.

## R3 — CORS: ADR-003's claim holds, but its test was incomplete

ADR-003 says CORS is open by default. First re-verification appeared to **contradict** it —
a plain GET returned no `Access-Control-Allow-Origin` at all.

**The claim is correct; the test was wrong.** ClickHouse echoes CORS headers **only when the
request carries an `Origin`** — which a browser always sends and `curl` never does unless
told. With `-H "Origin: http://localhost:3000"`:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, GET, OPTIONS
```
Preflight `OPTIONS` → **204** with the same headers. The browser path is clear.

**Recorded as a testing trap**: never conclude "CORS is broken" from a curl without `Origin`.
Ten minutes were nearly spent redesigning around a phantom.

**Also found**: passing `add_http_cors_header=1` as a URL param **fails with HTTP 500** for
the readonly `site` user — it is a setting, and `readonly=1` forbids setting modification
(the same family as trap #3). It is also unnecessary. **Do not pass it.**

## R4 — The saturation constant: replaced, because measurement refuted it

Carried over from the spec's Verified Measurements, as the decision record.

**Decision: percentile (p95) robust scaling on both terms; no invented constant.**

```
demand_n = least(100, 100 * pop / p95(pop))
supply_n = least(100, 100 * sup / p95(sup))
gap      = demand_n * (100 - supply_n) / 100
```

**Rationale**: ring supply runs median 1 → p75 4 → **max 64**. The inherited "3 = saturated"
sits at p75, so it would have flattened a third of Berlin into "fully saturated" and
degenerated the score into "wherever the most people live". p95 rather than max so one
outlier cell cannot compress the rest; `greatest(p95, 1)` guards a division by zero for a
category with almost no supply (spec edge case).

**Alternatives considered**:
- *Justify a constant from the data* (e.g. "p90 = 12 = saturated") — rejected: still a magic
  number, still breaks on a category with a different distribution, and it must be re-derived
  per city and category. The percentile derives itself at query time.
- *Rank/percentile-of-cell instead of value scaling* — rejected: destroys the magnitude
  information ("twice as many people" becomes "one rank higher") and makes the formula
  harder to explain in one breath, which is FR-008's whole point.

## R5 — GeoJSON assembly on 26.4, and the H3 lat-first family

Cloud is 26.4: no `GeoJSON` format, no MVT (verified absent, ADR-003). Assembled by hand with
`concat` + `toJSONString`; **verified valid by parsing the output**, not by eye.

**The whole H3 function family is lat-first**, verified per-function rather than assumed:

| Function | Returns / takes | Verified |
|---|---|---|
| `geoToH3(lat, lon, res)` | lat first | known trap #1 |
| `h3ToGeo(h3)` | `(lat, lon)` → `(52.5236, 13.3737)` | **new, 19 Jul** |
| `h3ToGeoBoundary(h3)` | `[(lat, lon), …]` → `(52.5266, 13.3684)` | **new, 19 Jul** |

GeoJSON requires `[lon, lat]`, so **every** vertex needs an explicit swap: `v.2, v.1`. Getting
it wrong is silent — a bbox filter with swapped elements returns **zero rows and no error**
(this happened while writing the spec). Both new findings are in `CLAUDE.md`.

## R6 — Query performance

All measured warm, against the live service, `default` user.

| Layer | Query | Payload | Verdict |
|---|---|---|---|
| Competitor dots (1,460) | **430 ms** | **175 KiB** | inline |
| GAP choropleth (2,260 cells) | **700 ms** | **549 KiB** | **handle** (2.1× budget) |
| Top-3 pins | ~700 ms | < 1 KiB | inline |

Total ClickHouse work < 3 s including the handle round-trip — inside SC-002 (first layer 3 s,
complete 15 s) with room for LLM latency.

**Note**: 549 KiB confirms ADR-001's "~500 KiB, fits, no margin" estimate and vindicates
FR-014 — the choropleth is 54% of the hard cap, so it takes the handle path on the **happy
path of the primary demo**. The mitigation therefore runs on every single question and cannot
rot unnoticed until day 6.

## R7 — Determinism of the ranking

**Decision**: `ORDER BY gap DESC, pop DESC, cell ASC`.

Verified: three consecutive runs produced an **identical result hash**. The `cell` tiebreak
makes the order total, so ties at the p95 clamp (measured: 3 cells at exactly 100.0) cannot
reorder between runs. Satisfies FR-004 / SC-005.

## R8 — The public token and constitution V

The browser must authenticate as `site`, so its password ships in the client bundle. This is
**by design** (ADR-003: a public token, the same posture as `play.clickhouse.com` and
Mapbox's public tokens) and is safe because `readonly=1` is not escapable from the client —
ADR-003 verified `CREATE TABLE` → 497, setting overrides → 164, `system.users` → 497.

**It is still a credential and must not enter git** (constitution V). It reaches the client
through `NEXT_PUBLIC_*` env vars read from the gitignored `.env`; `.env.example` carries the
contract only. The CI gitleaks gate is untouched.

## Open risk carried into implementation

**A maximal score can mean "a park".** Day 3 does not model land use, so a cell may score 100
because nobody lives *near* it who is served — or because it is a cemetery with houses at its
edge. The top-3 measured (Mariendorf, Hellersdorf/Kaulsdorf, Köpenick) are plausible
residential areas, so this is **not** currently firing. Mitigation if it does: filter
candidate cells by a minimum population floor — a `WHERE`, not a score change. Not built
until observed.
</content>
