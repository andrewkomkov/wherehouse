# WhereHouse

**Ask where to open your business. Get a map, not an essay.**

A geospatial chat agent for site selection: *"Where should I open a bakery in Berlin?"*
— and the answer assembles itself on a map. Competitors drop in, walking-distance
isochrones bloom outward, a demand-vs-supply choropleth fades in, three ranked sites
pin themselves. Two sentences of text, tops.

Built for the **ClickHouse × Trigger.dev Virtual Summer Hackathon 2026**
(theme: *Beyond the Wall of Text*).

> **Status: day 1 of 7.** Research and architecture are done and verified; application
> code starts now. See [`docs/research/findings.md`](docs/research/findings.md).

## Who it's for

- **Investors / municipalities** — where to put a kindergarten, a clinic, a pharmacy
- **Operators** — where to open the next coffee shop, bakery, or gym

The question "where?" is inherently spatial. Answering it with prose is the exact
failure the hackathon theme is about.

## How it works

```
   you ask ──▶ Trigger.dev chat.agent()  ──▶ ClickHouse Cloud  (POIs, H3 scoring)
                        │                          ▲
                        │                          │
                        ├──▶ Valhalla ─────────────┘  (isochrones → h3PolygonToCells)
                        │
                        └──▶ data-map parts ──▶ MapLibre  (the answer)
```

**ClickHouse** is the primary database *and* — as a deliberate stunt — the web server
itself. The page is a row in a `MergeTree`, served as real `text/html` over a plain
GET, with the browser querying ClickHouse directly (CORS is open by default). No Node,
no nginx, no API layer. See [ADR-003](docs/architecture/clickhouse-as-webserver.md).

**Trigger.dev** orchestrates the agent. Its `chat.agent()` streams custom `data-*`
parts with stable ids that **update in place** — which is why the map fills in
progressively while the agent is still thinking, instead of appearing at the end.
See [ADR-001](docs/architecture/progressive-map.md).

**Data** is [Overture Maps](https://overturemaps.org) parquet on public S3, queried in
place with `s3()` — no ingestion pipeline. Berlin's full category histogram comes back
in 4 seconds, cold. See [ADR-002](docs/architecture/data-sources.md).

## Docs

| | |
|---|---|
| [`docs/research/findings.md`](docs/research/findings.md) | The research digest — brief decoded, verified capabilities, traps, open questions |
| [`docs/architecture/progressive-map.md`](docs/architecture/progressive-map.md) | ADR-001 — the map *is* the response |
| [`docs/architecture/data-sources.md`](docs/architecture/data-sources.md) | ADR-002 — Overture on S3, queried in place |
| [`docs/architecture/clickhouse-as-webserver.md`](docs/architecture/clickhouse-as-webserver.md) | ADR-003 — serving the app *from* ClickHouse |
| [`CLAUDE.md`](CLAUDE.md) | Working notes, live infra, traps |

## Setup

```sh
cp .env.example .env   # fill in ClickHouse + Trigger.dev credentials
```

## Licence

MIT — see [LICENSE](LICENSE).

Map data © [OpenStreetMap](https://openstreetmap.org) contributors, via
[Overture Maps](https://overturemaps.org) (ODbL) and [Protomaps](https://protomaps.com).
