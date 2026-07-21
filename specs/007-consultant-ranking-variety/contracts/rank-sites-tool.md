# Contract — `rankSites` tool (extended)

The one public interface this feature changes. Backward compatible: a call with only `{city, category}` behaves exactly as today.

## Input (zod)

```ts
{
  city: string,                 // berlin | amsterdam | belgrade  (required)
  category: string,             // a shining trade or a group      (required)
  strategy?: "balanced" | "demand" | "low_competition" | "accessible",  // default "balanced"
  order?: "best" | "worst",     // default "best"
  district?: string,            // optional; name-contains on either district tier
  count?: number,               // int 1..6, default 3
  page?: number,                // int >=1, default 1
}
```

## Output (model-facing)

Success:
```ts
{
  lens: { strategy, order, district?, page },   // so the caption can state the active lens
  picks: [
    { rank, place?, gap, population, competitorsNearby,
      builtFloorAreaM2?, addressCount?, complementaryNearby? },
    ...                                          // up to `count`, up to 6
  ]
}
```
The full pick geometry + `lens` descriptor ride the `picks` map layer part out-of-band (ADR-001); the model sees only the summary above.

District no-match:
```ts
{ error: "no cells in that district", district, available: string[] }   // FR-006
```
Empty (non-district) / bad city: same errors as today (`no populated cells…`, `unavailable`).

## Guarantees

- `strategy=balanced, order=best, page=1` (or omitted) ⇒ identical pins to the pre-feature tool (FR-002).
- Deterministic per (strategy, order, district, page) (FR-009).
- `place` values are the only place names the agent may utter (FR-012).
- `count` clamped to 1..6; a district/page with fewer candidates returns fewer, never padded (FR-008, INV-4).

## Agent routing (system prompt)

| user intent | params |
|---|---|
| "biggest market", "most demand / customers" | `strategy=demand` |
| "least competition", "safest", "most room" | `strategy=low_competition` |
| "best foot traffic", "walkability" | `strategy=accessible` |
| "where NOT to open", "avoid", "worst / most saturated spots" | `order=worst` |
| "best <trade> in <place>" | `district=<place>` |
| "more options", "other options", "show more" | `page += 1` (or `count` up to 6) |

`order=worst` is distinct from the existing `highlightExtreme` UI tool, which only marks a single cell on the already-drawn surface; worst-mode produces a fresh ranked answer of saturated cells.

## Consistency of dependent tools

`showCatchment`, `saveSite`, `focusPick` accept the same optional `strategy`/`order`/`district`/`page` (default balanced/best/none/1) so a follow-up inside a lensed context re-derives the same pins it is acting on. The mandatory build sequence passes none ⇒ unchanged. `focusPick` rank range becomes 1–6.
