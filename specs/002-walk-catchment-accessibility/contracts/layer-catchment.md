# Contract — the `catchment` layer and the `showCatchment` tool

The product's external interfaces are the agent's tools and the `data-map` parts they emit.
This is the one new pair.

## Tool: `showCatchment`

```ts
description:
  "Show the real measured walk catchment around the best place to open — the area a customer " +
  "can actually reach on foot in 10 minutes, following streets. Call this after rankSites."
inputSchema: { city: string, category: string }   // the same `target` shape as the other three
```

**Deliberately takes no h3.** It re-derives the #1 pick with the same `rankSql` the agent just
ranked on, which is a total order (001 FR-004) and therefore deterministic. Passing the cell id
through the model would be a hallucination surface bought for nothing — see research.md D5.

### Returns (what the MODEL sees — ADR-001)

```jsonc
// measured
{ "minutes": 10, "reachablePeople": 14780, "lobes": 1 }

// not measured for that cell
{ "catchment": "not measured", "reason": "no walkable edge within 150 m of the cell centre" }

// city we hold no data for
{ "error": "unavailable", "available": ["berlin", "amsterdam", "belgrade"] }
```

`reachablePeople` is the **only** number in this product the agent may describe as a walk, and
it exists in the payload precisely so that the prompt's walk-ban can be narrowed to *"only what
a tool measured"* rather than lifted (spec FR-013).

The not-measured branch returns a **reason, not an empty success**. An empty success would let
the model narrate a catchment that isn't there; a reason gives it something true to say.

### Emits

A `data-map` part under the stable id `catchment` — same in-place-update contract as every other
layer (ADR-001, proven day 2: `parts=1` across two writes, content changed).

**Nothing is emitted at all when the cell is unmeasured.** No empty `FeatureCollection`, no
placeholder shape, no zero-area polygon. The wave stays `○` and the chip stays absent. A drawn
nothing and an undrawn nothing are different claims (spec US1 AS3).

## Part: `data-map` / `id: "catchment"`

```ts
{
  layer: "catchment",
  label: "10-minute walk from the top pick",
  rowCount: <lobe count>,
  kind: "inline",          // small; emitLayer decides on measured bytes, as always
  geojson: FeatureCollection<Polygon>
}
```

### Feature shape

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "Polygon", "coordinates": [[[13.40,52.51], ...]] },
  "properties": { "minutes": 10, "h3": "881f18b021fffff", "rank": 1 }
}
```

**One Feature per lobe.** A multi-lobed contour is several rows in `geo.isochrones` and stays
several Features here. Merging them into a MultiPolygon would be equivalent; *dropping* the
minor ones would not, and that is the documented failure mode (`infra/valhalla.sh`, `denoise`):
it is how a catchment ends up drawn 2 km from the cell it is labelled with.

**Coordinates pass through untouched.** The `geojson` column holds exactly what Valhalla emitted,
GeoJSON is `[lon, lat]`, and MapLibre wants `[lon, lat]`. No swap anywhere on this path. (The
H3 family is lat-first, `h3PolygonToCells` is lon-first, and this column is neither — it never
went through H3. Do not "make it consistent".)

## Client contract

| concern | rule |
|---|---|
| render | a MapLibre `fill` + `line` source keyed `catchment`, under `picks`, over `opportunity` |
| toggle | independent; toggling it MUST NOT touch another layer (spec FR-005) |
| wave | "Walk catchment · Valhalla" — `●` iff the layer is genuinely on the map, `◐` iff the tool is genuinely executing. Never a timer. |
| chip | `CATCHMENT · MEASURED` appears **iff** this layer is on screen (spec FR-003) |
| reveal | the contour draws on; it does not fade in as decoration. Motion represents the layer arriving, per the design brief's rule. |

## Changed contract: `data-map` / `id: "opportunity"`

Gains `scale.accP95` and `notMeasured`, and its GeoJSON features gain an **optional** `acc`
property — omitted, never null, never 0. See [../data-model.md](../data-model.md).

This is a widening: a client that ignores `acc` still renders the old two-factor colours from
`gap`. It just renders the *wrong* colours, because `gap` is now the three-factor score — so
the client is not actually optional, and `pnpm verify:score` is what proves it kept up.
