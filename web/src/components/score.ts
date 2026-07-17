/**
 * The GAP score, re-derived in the browser so the sliders cost nothing.
 *
 * ## Why this file is allowed to exist at all
 *
 * `web/src/trigger/scoring.ts` owns the score. Restating a formula in a second language is
 * exactly how two implementations drift apart, so this one only earns its place because of a
 * hard property it is built to preserve:
 *
 *     at NEUTRAL weights, this file MUST produce the number ClickHouse already produced.
 *
 * That is not a hope — it is checked. `pnpm verify:score` (scripts/verify-score.mjs) pulls the
 * real Berlin/Amsterdam/Belgrade cells out of ClickHouse and compares, cell by cell, all three
 * encodings of the formula: the SQL, the JS below, and the MapLibre expression below.
 * Measured 2026-07-20: **0 mismatches across 4,075 cells, max |Δ| = 0**.
 *
 * ## The shape, and why it is not the comp's weighted sum
 *
 * The server score is a PRODUCT:
 *
 *     gap = demand_n × (100 − supply_n) / 100
 *
 * A weighted sum (what the mockup does) would break its meaning: a cell with zero residents
 * would still score 50 on "no competition here", which is false — an empty field has no
 * competitors and no customers. The product says "you need both", and that is the honest claim.
 *
 * So weights are applied as EXPONENTS, which keeps the product shape and collapses to the
 * server's formula exactly at neutral:
 *
 *     gap(w) = 100 × Π_i ( term_i / 100 ) ^ ( N · w_i / Σw )
 *
 * With N factors at equal weight every exponent is 1 and the product is the server's. Adding a
 * third factor (accessibility, once Valhalla isochrones land) is one entry in FACTORS below —
 * no rewrite, and neutral still reduces to the plain product of whatever factors exist.
 *
 * ## Why the scaling constants have to be shipped rather than re-derived here
 *
 * `demand_n`/`supply_n` are scaled by the p95 of pop/sup **over the cells of that city and
 * category**, re-derived per query (scoring.ts, FR-007/FR-010). The browser cannot invent them:
 * recomputing a p95 client-side would be a *different* p95 (a different interpolation rule is
 * enough), and the map would silently disagree with the ranking the agent just gave. So the
 * server sends the two scalars it actually used — see `Scale` and MapData.scale.
 */

import type { ExpressionSpecification } from "maplibre-gl";

/**
 * The p95 scalars ClickHouse used for THIS query's `gap`. Not re-derivable in the browser —
 * see the header. Sent on the `opportunity` part.
 */
export type Scale = { popP95: number; supP95: number };

/** The per-cell properties the choropleth GeoJSON carries (scoring.ts → choroplethSql). */
export type CellProps = {
  /** The score ClickHouse computed, at neutral weights. Kept for the neutral fast path. */
  gap: number;
  /** Kontur residents. Integral in all three countries — verified, so `round()` in SQL is lossless. */
  pop: number;
  /** Competitors in the k=1 ring (~1 km across). */
  sup: number;
};

export type FactorId = "residents" | "lowCompetition";

type Factor = {
  id: FactorId;
  /**
   * What the slider is called. **"Residents", not "Footfall"** — the mockup said footfall and
   * that is a different quantity we do not have. Kontur counts people who LIVE in the cell; a
   * bakery is walked to by residents but also by commuters a resident count cannot see. Naming
   * it footfall would be a plausible-sounding falsehood, which is the failure mode this project
   * has already been bitten by twice (constitution II).
   */
  label: string;
  /** The one-line honesty note under the label. */
  note: string;
  /** The factor's value for a cell, 0..100. */
  term: (p: CellProps, s: Scale) => number;
  /** The same value as a MapLibre expression, so recolouring never re-serializes the layer. */
  expr: (s: Scale) => ExpressionSpecification;
};

/**
 * The factors the user may re-weight — **exactly the ones we have data for**.
 *
 * Deliberately absent, and each absence is a decision:
 *
 * - **Low rent** — cut. We hold no rent data: no source, no proxy, nothing. The mockup fills it
 *   with a Gaussian field. A slider with nothing behind it is a control that lies every time it
 *   is dragged, and it is the first thing a domain expert on the jury would test.
 * - **Accessibility** — not yet. Valhalla isochrones are being computed as this ships. It slots
 *   in here as a third entry the day the data is real; the exponent form already generalises to
 *   N factors, so nothing else changes.
 */
export const FACTORS: readonly Factor[] = [
  {
    id: "residents",
    label: "Residents",
    note: "Kontur · people who live here",
    // demand_n = least(100, 100 * pop / pop_p95)
    term: (p, s) => Math.min(100, (100 * p.pop) / s.popP95),
    expr: (s) => ["min", 100, ["/", ["*", 100, ["get", "pop"]], s.popP95]],
  },
  {
    id: "lowCompetition",
    label: "Low competition",
    // NOT "within ~1 km", which is what this said until it was checked. Supply is
    // `h3kRing(h3_8, 1)`; measured live 2026-07-20, that ring reaches **1.391 km** from the cell
    // centre (h3EdgeLengthKm(8) = 0.531), so "~1 km" understates it by ~40%. The ring is the
    // thing we can prove, so the ring is what the label says.
    note: "Overture · rivals in the H3 ring",
    // 100 - supply_n, i.e. headroom. The server writes it as (100 - supply_n) inline.
    term: (p, s) => 100 - Math.min(100, (100 * p.sup) / s.supP95),
    expr: (s) => ["-", 100, ["min", 100, ["/", ["*", 100, ["get", "sup"]], s.supP95]]],
  },
];

export type Weights = Record<FactorId, number>;

/**
 * Neutral = every factor equal. This is the ONLY position at which the map is the agent's own
 * ranking; the UI says so when the user leaves it (see `isNeutral`).
 */
export const NEUTRAL: Weights = { residents: 50, lowCompetition: 50 };

export const isNeutral = (w: Weights): boolean =>
  FACTORS.every((f) => w[f.id] === NEUTRAL[f.id]);

/**
 * Slider positions → exponents. Only the RATIO matters: {50,50} and {80,80} are both neutral,
 * which is what a user expects from "weights".
 */
function exponents(w: Weights): Record<FactorId, number> {
  const vals = FACTORS.map((f) => Math.max(0, w[f.id]));
  const sum = vals.reduce((a, b) => a + b, 0);
  // Every slider at zero expresses no preference at all. Falling back to neutral is the only
  // reading that is not a divide-by-zero or an arbitrary winner.
  if (sum <= 0) return Object.fromEntries(FACTORS.map((f) => [f.id, 1])) as Weights;
  return Object.fromEntries(
    FACTORS.map((f, i) => [f.id, (FACTORS.length * vals[i]) / sum]),
  ) as Weights;
}

/** The score for one cell under `w`. At neutral this returns ClickHouse's own `gap`. */
export function gapOf(p: CellProps, s: Scale, w: Weights): number {
  const e = exponents(w);
  let acc = 100;
  for (const f of FACTORS) acc *= Math.pow(f.term(p, s) / 100, e[f.id]);
  return Math.max(0, Math.min(100, acc));
}

/** Same as `gapOf`, rounded the way ClickHouse rounds it, so the two are comparable as displayed. */
export const gapDisplay = (p: CellProps, s: Scale, w: Weights): number =>
  Math.round(gapOf(p, s, w) * 10) / 10;

/**
 * The score as a MapLibre expression.
 *
 * This is why the sliders are instant. The alternative — recompute `gap` in JS and `setData` —
 * ships 2,260 polygons through the worker on every pointer move and re-tiles them; a paint
 * property costs none of that. The brief bans latency here outright ("that immediacy is the
 * feature"), and the same pattern is already proven in the sibling project's `recolorAtdi()`.
 *
 * ⚠️ This and `gapOf` are two encodings of ONE formula. They must move together, and
 * `scripts/verify-score.mjs` fails the build's own check if they ever disagree — it evaluates
 * this expression through MapLibre's real evaluator against the same cells.
 */
export function gapExpression(s: Scale, w: Weights): ExpressionSpecification {
  const e = exponents(w);
  let acc: ExpressionSpecification = ["literal", 100] as unknown as ExpressionSpecification;
  for (const f of FACTORS) {
    acc = ["*", acc, ["^", ["/", f.expr(s), 100], e[f.id]]];
  }
  return ["max", 0, ["min", 100, acc]];
}

/**
 * The choropleth ramp, driven by the live score.
 *
 * Sequential, dark→bright: it reads as one quantity increasing, and it survives being drawn
 * under a semi-transparent isochrone band. Note where it does NOT go — it stops at `#8ff2dd`
 * and never reaches the yellow. `#FAFF69` is spent on the #1 pick and nowhere else; if the ramp
 * ended there, the single most important pixel on the screen would be competing with 2,260
 * hexes for the same colour.
 */
export function fillColor(s: Scale, w: Weights): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    gapExpression(s, w),
    0,
    "rgba(20,32,48,0)",
    15,
    "rgba(22,46,68,0.4)",
    40,
    "#1c5a7a",
    65,
    "#2b9fae",
    85,
    "#57d8cf",
    100,
    "#8ff2dd",
  ] as unknown as ExpressionSpecification;
}
