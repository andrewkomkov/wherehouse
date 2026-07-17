# ADR-001: The map IS the response (progressive fill)

**Status:** locked in
**Date:** 2026-07-17

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
