# ADR-001: The map IS the response (progressive fill)

**Status:** ACCEPTED — core mechanism **proven on the live API** 18 July (day-2 skeleton)
**Date:** 2026-07-17 · **Verified:** 2026-07-18

> **What is proven vs assumed** (constitution II)
>
> **Proven** — in-place reconciliation, the load-bearing claim below. The skeleton's tool
> writes `id="map"` once per row, 1.5 s apart, with two real saved-site rows
> ~4 km apart in Berlin. Recorded in the browser:
>
> ```
> t=27977  parts=1 | showing=site 1/2: Kastanienallee corner
> t=29577  parts=1 | showing=site 2/2: Boxhagener Platz
> ```
>
> The part count holds at **1** while the content changes: parts merge on `type`+`id`,
> last write wins. The dot moved; it did not duplicate. Also proven: `{ rowCount }` reaches
> the model while the GeoJSON reaches only the UI, and typed `data-map` parts arrive in
> `message.parts`.
>
> **Also proven, 19 July** — the ID-reference fix below, end to end in the product. The
> browser fetched the 549 KiB choropleth straight from ClickHouse as the readonly `site` user
> (INSERT 770 ms / GET 550 ms, byte-identical), and a 781 KiB competitor layer went the same
> way on a real question. The 1 MiB cap is retired as a risk: an over-budget layer never
> touches the stream at all.
>
> **Refuted, 19 July — "the map survives a page refresh".** It does not. `useChat` mints a new
> `chatId` per mount, so a reload starts a fresh session and the map is empty. The SDK does
> offer hydration (`sessions` + `onSessionChange` + `reconnectToStream`), but that resumes a
> *live stream*; a finished answer has no stream, so restoring a completed map means replaying
> persisted parts. Descoped on day 3 — it moves no rubric criterion. This is the second claim
> in this ADR that survived only until it was executed.
>
> **Assumed still** — the seven-wave choreography below. Three waves have now run
> (competitors → choropleth → picks); isochrones and the viewport fly-in have not.
>
> **Refuted** — "the full payload goes to the UI" without qualification. See the 1 MiB cap
> section; it is the one thing in this ADR that day 2 broke.

## Context

Hackathon theme is *"Beyond the Wall of Text"*. Judging lens, verbatim:
> ratio of insight to words. Text is the garnish, not the meal.
> If your agent's best answer is a paragraph, you've missed the brief.

Rules also mandate meaningful use of Trigger.dev's `chat.agent()` (25% of score).

## Decision

The agent's answer is a **live MapLibre map that fills in as the agent reasons**,
not a map rendered once after the agent finishes. We stream custom `data-*` parts
from `chat.agent()` and render each as a React component.

Three properties of the Trigger.dev chat API make this work:

1. **Custom typed parts.** `chat.response.write({ type: "data-map", data })` emits a
   part that arrives in `message.parts` on the client, typed via `UIMessage<unknown, MyData, MyTools>`.
2. **Stable `id` → in-place reconciliation.** Writing again with the *same* `id`
   **updates that part in place** instead of appending. This is the whole trick:
   one `data-map` part, written many times, = a map that grows.
3. **`transient: true`** → frontend-only, never persisted to `responseMessage.parts`.
   Use for progress chrome ("querying ClickHouse…"), so it doesn't pollute history.

Non-transient parts *are* persisted, so **the map survives a page refresh** — the
chat is a durable task keyed on `chatId`.

## The choreography

A single question ("where do I open a bakery in Berlin?") paints the map in waves:

| Wave | Part | Source | What the user sees |
|---|---|---|---|
| 1 | `data-map` id=`viewport` | agent | map flies to Berlin, instantly |
| 2 | `data-status` (transient) | agent | "pulling 40k POIs from ClickHouse…" |
| 3 | `data-map` id=`competitors` | ClickHouse | competitor bakeries drop in as dots |
| 4 | `data-map` id=`isochrones` | Valhalla | 5/10/15-min walk polygons bloom outward |
| 5 | `data-map` id=`scores` | ClickHouse | H3 choropleth fades in, cell by cell |
| 6 | `data-map` id=`picks` | agent | top-3 sites pin + rank |
| 7 | text | agent | 2 sentences. The garnish. |

Waves 3–5 rewrite their own `id` in batches, so each layer *materializes*
progressively rather than popping in complete.

## Critical constraint: keep the model's context cheap

The tool returns a **summary** to the LLM; the **full payload goes to the UI**,
bypassing the model entirely:

```ts
execute: async ({ sql }) => {
  const rows = await ch.query({ query: sql }).then(r => r.json());
  chat.response.write({                      // → browser, full GeoJSON
    type: "data-map",
    id: "competitors",
    data: { points: rows },
  });
  return { rowCount: rows.length };          // → model, 1 number
}
```

Streaming 40k GeoJSON points through the LLM context would be slow, expensive, and
pointless — the model never needs to *read* the geometry, only know it landed.
Trigger.dev documents this as the `large-payloads` pattern. `toModelOutput` can also
shape a cheap model-facing view separately from the UI payload.

## Hard limit: ~1 MiB per stream record — and we already exceed it

Found while building the day-2 skeleton; this ADR previously assumed the UI payload was
unbounded. **It is not.** The realtime stream behind `chat.agent` enforces a per-record cap
of **1 MiB** (`1048576` bytes minus envelope). It applies to *everything* on the chat
stream, including `chat.response.write` — so it applies to `data-map`. Crossing it fails
the run with `ChatChunkTooLargeError`. It is platform-level and **cannot be raised**.

Measured against the real `geo.places` data (18 July), not estimated:

| Layer | Points | GeoJSON | Verdict |
|---|---|---|---|
| Berlin bakeries | 1,460 | 153 KiB | fits |
| Berlin food & drink | 12,746 | **1.27 MiB** | **fails** |
| Every Berlin POI | 139,807 | **14.9 MiB** | **fails** |
| H3 res-8 choropleth | 2,015 cells | ~500 KiB | fits, no margin |
| H3 res-9 choropleth | 9,035 cells | ~2.2 MiB | **fails** |

So the narrow demo query is safe and the *obvious* next question — *"show me every
restaurant"* — is a hard crash. This must be solved before any wide layer ships, and it
cannot be discovered on day 6.

**Fix — the ID-reference pattern, where our store is ClickHouse itself.** The docs say:
persist the payload, stream only a handle. We need no new store, because **ADR-003 already
proved ClickHouse Cloud serves HTTP directly and CORS is open** — the browser can query it
with the read-only `site` user:

```ts
// tool: stream a handle, not the geometry
chat.response.write({
  type: "data-map",
  id: "competitors",
  data: { queryId, rowCount: rows.length, bbox },  // bytes, not megabytes
});
return { rowCount: rows.length };
// browser: fetch the GeoJSON straight from ClickHouse using queryId
```

This turns the constraint into an asset: on stage the **browser talks to ClickHouse
directly**, which strengthens the 25% "use of ClickHouse" criterion rather than working
around it.

**Built and proven on day 3.** The store is `web.layers` (`db/clickhouse/004_layers_schema.sql`,
TTL 1 h). Two findings from building it:

- **It needs no access DDL at all.** `GRANT SELECT ON web.*` is a wildcard that already covers
  a new table — verified by canary. That matters beyond convenience: access DDL is what
  permanently wedged `p_html`/`web_html`/`web_html2`, and a design that never runs it cannot
  step on that mine.
- **The decision is made on measured bytes, not row counts** (`web/src/trigger/layers.ts`,
  budget 256 KiB = 4x margin). A row-count heuristic is a guess about average feature size and
  a category with long names breaks it silently.

The choropleth (549 KiB) takes the handle path on **every** question, so the mitigation runs on
the demo's own happy path and cannot rot unnoticed.

## Typing trap: do not intersect with `UIDataTypes`

The Trigger.dev docs show `type MyDataTypes = UIDataTypes & { "turn-status": {...} }`.
**Copying that costs you all client-side narrowing.** `UIDataTypes` is
`Record<string, unknown>`, so intersecting widens `keyof` to `string`; `DataUIPart` then
degrades from `data-map` to `` `data-${string}` `` with `data: unknown`, and
`Extract<Msg["parts"][number], { type: "data-map" }>` resolves to `never`. Declare the map
bare instead — `type WhereHouseDataTypes = { map: MapData }`.

## Consequences

- Tools MUST be declared on the agent config (`tools:`), not only passed to
  `streamText` — otherwise `toModelOutput` runs on turn 1 and is silently skipped
  on later turns.
- Frontend keys off `part.type`: `data-map` → map layer, `tool-<name>` → a "what
  the agent is doing" badge (e.g. show the actual SQL as it runs — judges love
  seeing real queries).
- `chat.headStart` cuts time-to-first-chunk ~2.8s → ~1.2s. Worth it for demo feel.
- The demo video (5 min, max) should open on this: one question, map assembling
  itself. That single shot is the entire pitch.
