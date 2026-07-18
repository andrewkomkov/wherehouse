# Feature 006 — the agent controls the whole UI, and exports a report

**Status:** spec · 2026-07-18
**One line:** anything the user can do by hand in the UI, the agent can do through a tool — and the
agent can export a shareable PDF report of the current answer.

## Why

Two gaps, both seen in live multi-turn testing:

1. **The agent talks when it should act.** "show me kindergarten best place" came back as a *talk*
   turn (no map change) instead of rebuilding for kindergarten; "show me the worst place" just
   replied. The agent can already paint layers, but it does not reliably drive the UI, and it has
   no tool for UI state that is not a layer (toggles, slider weights, selecting a pick, rewinding a
   run). The product feels half-agentic.
2. **No way to take the answer with you.** A siting decision is shared with partners/a landlord.
   Today the only export is a screenshot. The agent should export a clean **PDF** of the current
   answer.

Rubric: this is the 25% (Use of ClickHouse & Trigger.dev — the agent doing real work through
`chat.agent()` tools) and 20% Innovation (an agent that *operates* the instrument, not just
answers). "Beyond the Wall of Text": the agent's reply can be *an action on the map* or *a
document*, never a paragraph.

## The control surface — every UI action becomes an agent tool

The client already owns this state: `visible` (layer toggles), `weights` (the re-weight sliders),
`selected` (which pick's provenance panel is open), `selectedRunId` (which run the map is scrubbed
to), plus `sendMessage` (compare/save flows) and the map itself. Each becomes agent-drivable:

| Tool (agent) | Does | Drives |
|---|---|---|
| `setLayer(layer, on)` | show/hide a map layer | `visible` |
| `reweight({residents?, competition?, accessibility?})` | move the sliders (0–100 each) | `weights` — **only the three real factors; never "rent" (no data)** |
| `focusPick(rank)` | open a pick's provenance panel | `selected` |
| `highlightExtreme("worst"\|"best")` | mark the lowest/highest-opportunity **scored** cell | client computes it from the opportunity FC it already holds — **no new query, no invention** |
| `reviewRun(n)` | rewind the map to a past run | `selectedRunId` (the scrubber) |
| `exportReport()` | build + download the PDF (below) | client report generator |
| *(existing)* `findCompetitors`→`scoreArea`→`rankSites`→`showCatchment` | a full rebuild for a (city, category) | the map |
| *(existing)* `saveSite`, `compareSavedSites`, `categoryTrend` | save / compare / momentum | as today |

### Mechanism — a `data-ui` command channel (ADR-001 discipline)

UI tools emit a **`data-ui`** stream part: `{ id, action, ...args }`. Unlike `data-map` (a stateful
layer updated in place by a stable id), a UI command is **one-shot** — each carries a **unique id**,
and the client keeps an `appliedUi` set (mirror of `painted`) so each command applies exactly once,
even across re-renders and reconnects. The model only ever sees `{ ok: true, action }` back — the
full effect happens client-side, never in the model's context (same bypass as `data-map`).

The client has one effect that drains un-applied `data-ui` commands and calls the matching setter
(`setVisible`/`setWeights`/`setSelected`/`setSelectedRunId`/report). Applying a command must reuse
the exact same setters the buttons use, so agent-driven and hand-driven paths can never diverge.

### The "act, don't talk" reliability fix

The gap is also promptcraft: the `SYSTEM_PROMPT` must instruct the agent that **a request to change
what is on screen is a tool call, not a sentence** — a new trade/city is a full rebuild
(`findCompetitors`→`scoreArea`→`rankSites`→`showCatchment`); "worst/best place", "hide the
competitors", "weight walkability higher", "open pick 2", "go back to the bakery answer" are the UI
tools above. It may add one caption sentence *after* acting, never instead of acting. FR: a UI/rebuild
request must never resolve as a pure-text (`talk`) turn.

## The report — a downloadable PDF (FR-EXPORT)

`exportReport()` produces a **one-page A4 PDF, generated entirely client-side** (the app is a static
export served from ClickHouse — no server render), downloaded directly (no print dialog):

- **Composition** (deterministic, built with a light bundled lib, e.g. `jspdf`; the map image comes
  from `map.getCanvas().toDataURL()` — MapLibre is created with `preserveDrawingBuffer` so the
  capture is non-empty):
  - Header: WhereHouse mark, the question, city + trade, generated-at date.
  - The **map snapshot** (current layers as shown).
  - **Top picks** table: rank, place, score/100, residents, rivals, editorial neighbours.
  - **Market at a glance**: competitors, median opportunity, momentum (with "since 'YY").
  - **Provenance / honesty block**: measured / estimated / editorial legend; the not-measured cell
    count; attributions (Kontur CC BY, Overture, Valhalla, OSM/Protomaps).
- **Honesty invariants carry verbatim** (constitution II): the report states only what is on screen
  — no invented sentence, `absent != 0` (an unscored/absent datum is omitted, never a 0), the
  editorial tag stays on affinity, `#FAFF69` only on the #1 pick. The caption in the report is the
  agent's streamed text, not authored here.
- File name: `wherehouse-<city>-<trade>.pdf`.

## Out of scope

- No auth/multi-user. No server-side PDF (Cloudflare Browser Rendering) — client-side keeps the
  ADR-003 "served from ClickHouse, no server runtime" property.
- No new data sources; `highlightExtreme` and the report use data the client already holds.

## Acceptance (browser-verified, constitution II/III)

1. "hide the competitors" → the competitor layer toggles off (a `setLayer` tool call, run shows a
   step), not a talk turn.
2. "weight walkability to the max" → the Accessibility slider jumps and the choropleth recolours
   instantly, driven by the agent.
3. "show me the worst place" → the lowest-opportunity scored cell is marked, not a paragraph.
4. "what about kindergartens?" → a full rebuild runs (kind = rebuild), reliably, not talk.
5. "open the #2 pick" → its provenance panel opens.
6. "export a report" → a PDF downloads with the map, picks, metrics and provenance; opened, it
   reflects exactly what was on screen; no invented text; attributions present.
7. Every one of the above shows up as a real step in the run stack (a tool call), so the agentic
   trace stays honest.
