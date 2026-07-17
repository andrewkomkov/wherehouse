# Phase 1 — Data model

No new tables. This feature reads `geo.isochrones` and `geo.isochrone_cells`, which
`infra/valhalla.sh` built and verified on 17 July, and adds one nullable value to a payload
that already exists.

## The entities, and which side of the wall each lives on

`db/clickhouse/006_isochrones_schema.sql` split reachability into two tables on the read
pattern, and this feature is the first consumer to prove that split was right — it uses both,
for different things, and never confuses them:

| | `geo.isochrone_cells` | `geo.isochrones` |
|---|---|---|
| shape | fact: (origin, minutes, reachable cell) | the contour, as GeoJSON `coordinates` text |
| 635,080 rows / 63,479 rows | 635,080 | 63,479 |
| this feature uses it for | **the Accessibility score** | **the drawn layer** |
| joined? | yes — equality, on both sides' sort key | **never** |
| drawn? | never | yes, verbatim |

A contour is **rendered, never joined**. A reachable cell is **joined, never drawn**. Crossing
those is how you end up running `pointInPolygon` against 15k contours at demo time.

## Accessibility — a value that is allowed to be absent

**Definition**: the number of residents who can reach a cell on foot in 10 minutes, measured
from the cell's res-9 centre child against the real street network.

```
acc(cell) = Σ  population(h3ToParent(r, 8)) / 7
            r ∈ isochrone_cells[origin = h3ToCenterChild(cell, 9), minutes = 10]
```

| property | value |
|---|---|
| unit | people |
| domain | measured: `[0.286 … 23,979]` across the three cities — **or absent** |
| absent when | the centre child has no walkable edge within 150 m (Valhalla 4xx at load time) |
| absent means | **not measured**. It does **not** mean unwalkable, and it does not mean zero. |
| scale | `acc_p95`, derived per city and category at query time, shipped to the browser |

### The `population / 7` term is an approximation, and it is stated

Reach is res 9; Kontur is res 8. A reachable res-9 cell contributes one seventh of its parent's
residents — i.e. population is assumed uniform inside a res-8 cell. This is the same granularity
the product already ranks on, it cannot be removed without a finer demand source, and it is
written down here rather than buried in the SQL.

### Absent is not zero, and the difference is load-bearing

The score is a product. Both mistakes are silent and both are lies:

| fill-in | claim it makes | effect |
|---|---|---|
| `0` | "nobody can walk to this cell" | zeroes the cell — it vanishes from the ranking |
| `acc_p95` | "excellently connected" | may float a cell into the top 3 |
| **absent** | **"we did not measure this"** | the cell is excluded, visibly, and returns if the factor is weighted out |

A measured `acc` of **0.286** exists (verified) and is a *real* measurement — it must score, and
it must never be styled as not-measured. `0.286 ≠ absent` is a test, not a nicety.

## How absence travels — the same discipline as `place` in 001

| layer | representation of absence |
|---|---|
| SQL | the `acc` CTE is a `LEFT JOIN`; unmatched ⇒ no row in `acc`, `has_acc = 0` |
| choropleth GeoJSON | the `acc` property is **omitted from the feature entirely** |
| `CellProps` (TS) | `acc?: number` |
| MapLibre | `["has", "acc"]` |
| the model | never sees it — it sees `{ rowCount, notMeasured }` (ADR-001) |

**Omitted, not `null`, not `-1`, not `0`.** This is exactly the rule 001 established for
`place`: an absent key is invisible rather than empty-stringy, so nothing downstream can
mistake a sentinel for a value. `JSON.stringify` drops an `undefined` key for free; a `null`
would survive and would eventually be arithmetic'd.

## Changed payload contracts

### `Scale` (layers.ts) — gains one scalar

```ts
type Scale = { popP95: number; supP95: number; accP95: number };
```

Same reason as the other two, restated because it is the reason: the browser re-derives the
score for the sliders and **cannot** recompute a p95 — a p95 recomputed in JS is a *different*
p95 (a different interpolation rule between straddling samples is enough), and the map would
drift off the agent's ranking by a hair, silently.

### `MapData` (layers.ts) — gains a count and a layer id

```ts
type LayerId = "competitors" | "opportunity" | "picks" | "catchment";

type MapData = {
  layer: LayerId;
  label: string;
  rowCount: number;
  bbox?: BBox;
  scale?: Scale;
  /** Cells in this answer with no measured catchment. Only on `opportunity`. Measured per
   *  city and category — berlin/bakery is 830, amsterdam is 90. Never a constant. */
  notMeasured?: number;
} & ({ kind: "inline"; geojson: unknown } | { kind: "handle"; handle: string });
```

### `CellProps` (score.ts) — gains an optional term

```ts
type CellProps = {
  gap: number;   // ClickHouse's own score, now three-factor
  pop: number;
  sup: number;
  acc?: number;  // residents within a 10-min walk — ABSENT means not measured
};
```

## The catchment layer

One `FeatureCollection`, one Feature **per lobe** — `geo.isochrones` stores a multi-lobed
contour as several rows on purpose (445 of Berlin's contours are multi-lobed, verified), because
dropping the "minor" lobes is how a catchment gets drawn 2 km from the cell it is labelled with.

```
properties: { minutes: 10, h3: <the pick's res-8 cell>, rank: 1 }
```

Geometry comes out of the `geojson` column **verbatim**. Valhalla emits GeoJSON; GeoJSON is
`[lon, lat]`; it was stored exactly as emitted. Do not swap it, and do not "tidy" it — the
loader's own comment says the same thing, and this is the third H3/geo ordering trap in the
project.

## Invariants a check must defend

| invariant | verified | why it is the check that matters |
|---|---|---|
| a measured cell's contour reaches its own res-8 parent | 1,430 / 1,430, zero exceptions | fails loudly if the origin→reach join is ever wired backwards — a class of bug this project has shipped three times, and one that produces *plausible* output, never an error |
| `acc ≥ own_pop / 7` for every measured cell | 1,430 / 1,430 | corollary of the above; cheaper to read in a failure message |
| `min(acc) = 0.286`, not 0 | verified | guards against a `coalesce(...,0)` creeping in and silently converting *absent* into *zero* |
| SQL `gap` ≡ JS `gapOf` ≡ MapLibre `gapExpression` at neutral | 0 mismatches / 4,075 cells (2-factor, 20 Jul) | must stay 0 with three factors across three cities |
