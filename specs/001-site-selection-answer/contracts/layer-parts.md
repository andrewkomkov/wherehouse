# Contract — `data-map` parts (UI-facing) and handle resolution

**Spec**: [../spec.md](../spec.md) · **Research**: [../research.md](../research.md)

The interface between the agent and the browser. Everything here was executed live in Phase 0
(R1, R3) — including the full handle round-trip with the real 549 KiB choropleth.

## The part

```ts
type LayerId = "competitors" | "opportunity" | "picks";

type MapData = {
  layer: LayerId;
  label: string;        // caption, e.g. "1,460 bakeries in Berlin"
  rowCount: number;
  bbox?: [number, number, number, number];
} & (
  | { kind: "inline"; geojson: FeatureCollection }   // ≤ 256 KiB
  | { kind: "handle"; handle: string }               // > 256 KiB — fetch from ClickHouse
);
```

⚠️ **Do not write `UIDataTypes & { map: MapData }`**, as the Trigger.dev docs' example does.
`UIDataTypes` is `Record<string, unknown>`, so intersecting widens `keyof` to `string`, the
part type degrades to `` `data-${string}` `` with `data: unknown`, and every bit of
client-side narrowing dies silently. Declare it bare: `type WhereHouseDataTypes = { map: MapData }`.

## Emission

`chat.response.write({ type: "data-map", id: <LayerId>, data })` — **the part id is the layer
id**. Rewriting the same id updates the part in place rather than appending (ADR-001, proven
day 2: `parts=1` held across two writes while the content changed). That is what lets each
layer fill progressively and independently.

## The inline-vs-handle decision

Made on **measured serialized bytes**, never on a row count (FR-012) — a category with long
names breaks any row-count guess.

| | Budget | Measured |
|---|---|---|
| Inline | ≤ **256 KiB** | competitors 175 KiB, picks < 1 KiB |
| Handle | > 256 KiB | opportunity **549 KiB** |

256 KiB is a **4× margin** under the ~1 MiB hard cap, leaving room for envelope overhead and
concurrent parts. The cap is platform-level and **cannot be raised**; crossing it fails the
run with `ChatChunkTooLargeError`.

## Handle resolution — the browser reads ClickHouse directly

```
GET {CLICKHOUSE_URL}/?user=site&password=<public token>
    &query=SELECT body FROM web.layers WHERE id='<handle>' FORMAT RawBLOB
```

**Verified end-to-end (R1)**: INSERT 549 KiB **770 ms** → browser GET **550 ms** →
**byte-identical**, 2,260 cells. CORS preflight `OPTIONS` → 204.

Rules learned by executing:

- **CORS is echoed only when the request carries `Origin`.** A browser always sends it; curl
  never does unless told. A curl test without `-H "Origin: …"` shows no CORS headers and
  looks like a broken server. It is not. Do not redesign around this phantom.
- **Never pass `add_http_cors_header=1`** — it is a setting, `readonly=1` forbids setting
  modification, and it returns **HTTP 500** for the `site` user. It is also unnecessary.
- **No `http_response_headers`** either (same reason — trap #3, `Code: 164`). The response
  arrives as `text/plain`; `fetch().then(r => r.json())` does not care about content-type.
- **No access DDL is needed, ever.** `GRANT SELECT ON web.*` is a wildcard already covering
  `web.layers` — verified by canary. This is the trap-#4 mitigation, not a shortcut.

## Client rendering

| Layer | MapLibre | Note |
|---|---|---|
| `competitors` | `circle`, small, muted | context, not the answer |
| `opportunity` | `fill`, ramp on `properties.gap` | the surface; sits under the others |
| `picks` | `circle` + `symbol`, ranked 1–3 | the answer; always on top |

Layers render as they arrive; a `handle` layer shows its `rowCount`/`label` immediately and
paints when the fetch lands.

**Kontur attribution (CC BY 4.0) is displayed on every view showing the map** (FR-017). This
is a licence obligation, not a courtesy. The population is a **2023-11-01 snapshot** and the
UI must not imply live demand (FR-018).

## Credentials

The `site` password ships in the client bundle **by design** — a public token, the same
posture as `play.clickhouse.com` and Mapbox. It is safe because `readonly=1` is not escapable
from the client (ADR-003 verified: `CREATE TABLE` → 497, setting overrides → 164,
`system.users` → 497).

It is **still a credential**: it reaches the client via `NEXT_PUBLIC_*` read from the
gitignored `.env`, and `.env.example` carries the contract only. The gitleaks gate is not
touched (constitution V).
</content>
