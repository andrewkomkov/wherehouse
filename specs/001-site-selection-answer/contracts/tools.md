# Contract — agent tools (model-facing)

**Spec**: [../spec.md](../spec.md) · **Plan**: [../plan.md](../plan.md)

The interface between the LLM and the product. The governing rule is ADR-001 and
constitution's *"large payloads never through the model's context"*: **every return value
here is a handful of numbers.** No tool returns geometry, and no tool returns prose for the
model to relay — a tool that did would have failed its purpose (constitution I).

`showSavedSites` is **deleted** (FR-020). It was built to exercise the ADR-001 gate; the gate
passed on day 2, and its deliberate double-write is a defect in a real tool.

## Shared input

```ts
{
  city: "berlin" | "amsterdam" | "belgrade",
  category: string    // Overture taxonomy, e.g. "bakery"
}
```

Category matching is exact against the Overture taxonomy, with a small synonym map for the
demo questions. If the city or category is not held, the tool returns
`{ error: "unavailable", available: [...] }` and the agent says so plainly — it MUST NOT
render an empty map that reads as "nowhere is good" (FR-005, spec edge case 2).

---

## `findCompetitors`

Puts the existing competitors on the map.

**Emits**: layer `competitors` — points.
**Returns**: `{ rowCount: number, bbox: [number,number,number,number] }`

**Measured (Berlin bakeries)**: 1,460 rows · 430 ms · **175 KiB ⇒ inline**.

---

## `scoreArea`

The opportunity surface — the heart of the answer.

**Emits**: layer `opportunity` — H3 res-8 polygons with `{ gap, pop, sup }` per cell.
**Returns**: `{ cellCount: number, topGap: number, medianGap: number }`

**Measured (Berlin bakeries)**: 2,260 cells · 700 ms · **549 KiB ⇒ handle**.

⚠️ This tool is **always** on the handle path (FR-014). That is deliberate: 549 KiB is 54% of
the hard cap with no safe margin, and routing the primary demo's own layer through the
mitigation means the mitigation runs on every question and cannot rot unnoticed until day 6.

---

## `rankSites`

The three recommendations.

**Emits**: layer `picks` — 3 points, each carrying `{ rank, gap, pop, sup }`.
**Returns**: `{ picks: [{ rank, gap, pop, sup }] }` — 3 rows of small numbers.

This is the one tool whose return the model may legitimately mention, because FR-003 requires
the user to see the population and competitor count behind each pick. Even so the **map**
carries them; the model's two sentences are the garnish.

**Ordering**: `gap DESC, pop DESC, cell ASC` — total, verified stable across three runs (FR-004).

**Measured (Berlin bakeries)**: 3 rows · ~700 ms · < 1 KiB ⇒ inline. Top-3: Lichtenrade (6,826 people, 0 bakeries in
ring), Biesdorf (6,807, 0), Mahlsdorf (5,860, 0).

---

## Rules binding all three

1. **Return counts, never geometry** (ADR-001, proven day 2).
2. **Never emit a layer directly** — always through `emitLayer()`, which measures bytes and
   picks inline-vs-handle (FR-012). A tool that calls `chat.response.write` itself has
   bypassed the only thing standing between the demo and `ChatChunkTooLargeError`.
3. **One part id per layer**, stable across rewrites: `competitors`, `opportunity`, `picks`.
   ADR-001's in-place merge is what lets a layer fill progressively.
4. **Declare tools on the agent config** (`tools:`), not only on `streamText` — otherwise
   `toModelOutput` runs on turn 1 and is silently skipped afterwards (ADR-001 consequence).
5. **The score is a ranking heuristic over real inputs, not a measurement** (FR-019). Neither
   the tools nor the model may present it as fact.
</content>
