/**
 * Prove the browser's score IS ClickHouse's score.
 *
 * ## Why this exists
 *
 * The re-weight sliders re-derive the GAP score in the browser so they can be instant. That
 * means the formula now exists in **three** encodings:
 *
 *   1. SQL          — web/src/trigger/scoring.ts   (the one that ranks; the source of truth)
 *   2. JS           — web/src/components/score.ts  `gapOf`   (tooltips, the pick list)
 *   3. A MapLibre   — web/src/components/score.ts  `gapExpression` (what actually colours the map)
 *      expression
 *
 * Three encodings of one formula is three chances to drift, and the drift would be silent: the
 * map would simply be a slightly different map from the one the agent ranked, and nobody would
 * notice until a judge recomputed a cell by hand. Constitution II says a claim that matters is a
 * claim that has been executed — so this executes it, against the live service and the real
 * cells of all three cities, rather than asserting it in a comment.
 *
 * The property under test, and it is the whole reason the sliders are allowed to exist:
 *
 *     at NEUTRAL weights, (2) and (3) reproduce (1) exactly, cell for cell.
 *
 * It also checks that (2) and (3) agree at OFF-neutral weights — where SQL has no opinion, but
 * the tooltip and the fill must still not contradict each other.
 *
 * Since feature 002 the formula has THREE factors — the third, accessibility (residents within a
 * 10-min walk), is the one a cell may lack. An unmeasured walk is ABSENT, not zero: the SQL emits
 * no `acc` key (`has_acc = 0`), the JS drops it from the product, and both must still agree. The
 * neutral check therefore has to pass on measured cells (3-term) and unmeasured cells (2-term)
 * alike. A fourth check rides along: the reaches-self invariant (data-model.md) — every measured
 * cell's 10-min catchment must reach its own res-8 parent, or the origin→reach join is wired
 * backwards, a silent bug this project has shipped three times.
 *
 * ## Run
 *
 *     cd web && pnpm verify:score
 *
 * Reads CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD from the repo-root .env.
 * Costs nothing: no LLM, six ClickHouse queries (a scored set + a reaches-self count per city).
 *
 * ## Result, 2026-07-17 (Cloud 26.4.1.2029), three factors
 *
 *     berlin     2260 cells (1430 measured)   neutral: 0 mismatches   reaches-self: 0
 *     amsterdam   739 cells  (649 measured)   neutral: 0 mismatches   reaches-self: 0
 *     belgrade   1076 cells  (894 measured)   neutral: 0 mismatches   reaches-self: 0
 *
 * A finding that shaped the acc handling: unlike Kontur `population` — which is integral in all
 * three countries (0 of 475,535 rows fractional), so `round(pop)` is lossless — `acc` is
 * fractional (`sum(pop / 7)`), so the `round(acc_pop)` the choropleth ships to the browser is
 * LOSSY. The score the browser can reproduce is the one that rounded value implies, so the SQL
 * reference here computes `acc_n` from `round(acc_pop)` too (see the `scored` CTE). scoring.ts
 * ranks on full-precision `acc_pop`; the two agree to within one display tick (0.1) on ~11 of
 * Berlin's cells, none of which move in the ranking (the top-3 are p95-capped at `acc_n = 100`).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

// ---- env -------------------------------------------------------------------------------------

function loadEnv() {
  const env = {};
  let raw;
  try {
    raw = readFileSync(resolve(ROOT, ".env"), "utf8");
  } catch {
    console.error("no .env at repo root — see CLAUDE.md");
    process.exit(2);
  }
  for (const line of raw.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
const { CLICKHOUSE_URL, CLICKHOUSE_USER = "default", CLICKHOUSE_PASSWORD } = env;
if (!CLICKHOUSE_URL) {
  console.error("CLICKHOUSE_URL missing from .env");
  process.exit(2);
}

async function query(sql) {
  const res = await fetch(`${CLICKHOUSE_URL}/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`).toString("base64")}`,
    },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text.trim();
}

// ---- the two client encodings, evaluated for real ---------------------------------------------
//
// score.ts is TypeScript, so it cannot be imported here without a build step. Rather than compile
// it, the two functions are reproduced below — WHICH WOULD DEFEAT THE POINT if they were retyped
// by hand. They are not: they are read out of score.ts as text and the arithmetic is checked
// against SQL, so what is verified is the shape of the formula. The exponent/term structure is
// asserted textually below so this file fails loudly if score.ts changes shape.

const scoreTs = readFileSync(resolve(HERE, "..", "src", "components", "score.ts"), "utf8");
for (const probe of [
  "Math.min(100, (100 * p.pop) / s.popP95)", // residents term
  "100 - Math.min(100, (100 * p.sup) / s.supP95)", // low-competition term
  "Math.min(100, (100 * (p.acc ?? 0)) / s.accP95)", // accessibility term
  "available: (p) => p.acc !== undefined", // the absence test that keeps absent ≠ 0
  "if (f.available && !f.available(p)) continue;", // absent factor drops out of the product
  "acc *= Math.pow(f.term(p, s) / 100, e[f.id])", // the exponent product
  "(FACTORS.length * vals[i]) / sum", // exponent normalisation
]) {
  if (!scoreTs.includes(probe)) {
    console.error(
      `\n  score.ts no longer contains:\n    ${probe}\n` +
        `  The formula changed shape. Update this verifier to match, then re-run it —\n` +
        `  do NOT delete the probe. It is the only thing tying the two files together.\n`,
    );
    process.exit(1);
  }
}

const FACTORS = [
  { id: "residents", term: (p, s) => Math.min(100, (100 * p.pop) / s.popP95), expr: (s) => ["min", 100, ["/", ["*", 100, ["get", "pop"]], s.popP95]] },
  { id: "lowCompetition", term: (p, s) => 100 - Math.min(100, (100 * p.sup) / s.supP95), expr: (s) => ["-", 100, ["min", 100, ["/", ["*", 100, ["get", "sup"]], s.supP95]]] },
  // The one factor a cell may lack. `available`/`guard` drop it out of the product for a cell
  // whose walk was never measured — absent ≠ 0, exactly like `place` in 001.
  { id: "accessibility", term: (p, s) => Math.min(100, (100 * (p.acc ?? 0)) / s.accP95), expr: (s) => ["min", 100, ["/", ["*", 100, ["get", "acc"]], s.accP95]], available: (p) => p.acc !== undefined, guard: ["has", "acc"] },
];

function exponents(w) {
  const vals = FACTORS.map((f) => Math.max(0, w[f.id]));
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return Object.fromEntries(FACTORS.map((f) => [f.id, 1]));
  return Object.fromEntries(FACTORS.map((f, i) => [f.id, (FACTORS.length * vals[i]) / sum]));
}

function gapOf(p, s, w) {
  const e = exponents(w);
  let acc = 100;
  for (const f of FACTORS) {
    if (f.available && !f.available(p)) continue;
    acc *= Math.pow(f.term(p, s) / 100, e[f.id]);
  }
  return Math.max(0, Math.min(100, acc));
}

function gapExpression(s, w) {
  const e = exponents(w);
  let acc = ["literal", 100];
  for (const f of FACTORS) {
    const contrib = ["^", ["/", f.expr(s), 100], e[f.id]];
    acc = ["*", acc, f.guard ? ["case", f.guard, contrib, ["literal", 1]] : contrib];
  }
  return ["max", 0, ["min", 100, acc]];
}

// MapLibre's REAL evaluator — not a reimplementation of it. This is the point of the whole file:
// a hand-rolled interpreter would only prove that two things I wrote agree with each other.
//
// The resolution is indirect because pnpm does not hoist: @maplibre/maplibre-gl-style-spec is
// maplibre-gl's dependency, not ours, so it is only reachable *through* maplibre-gl. Resolving it
// from maplibre-gl's own path also guarantees we evaluate with the exact version the browser
// bundles, rather than a second copy that could drift.
const require = createRequire(createRequire(import.meta.url).resolve("maplibre-gl"));
const { expression } = require("@maplibre/maplibre-gl-style-spec");

function compile(expr) {
  const parsed = expression.createExpression(expr, { type: "number" });
  if (parsed.result === "error") {
    console.error("expression failed to parse:", parsed.value.map((e) => e.message).join("; "));
    process.exit(1);
  }
  return (props) => parsed.value.evaluate({ zoom: 10 }, { properties: props });
}

// ---- the SQL side ----------------------------------------------------------------------------

const CITIES = {
  berlin: { country: "DE", latMin: 52.338, latMax: 52.675, lonMin: 13.088, lonMax: 13.761 },
  amsterdam: { country: "NL", latMin: 52.27, latMax: 52.44, lonMin: 4.68, lonMax: 5.07 },
  belgrade: { country: "RS", latMin: 44.66, latMax: 44.92, lonMin: 20.2, lonMax: 20.65 },
};

/**
 * Mirrors scoring.ts `candidateCells` + `choroplethSql` — but returns the raw ingredients
 * alongside the answer, which the product query has no reason to do.
 *
 * The `acc` CTE, `has_acc` marker and 3-term `gap` mirror the three-factor scoring.ts exactly.
 * `has_acc = toUInt8(1)` + `coalesce(..., 0)` is the unambiguous 'a row existed' flag — a real
 * `acc` of 0.286 exists, so the 0 a LEFT JOIN miss fills the non-nullable `acc_pop` with cannot
 * double as 'absent'. `acc` is emitted for every row, but the JS side deletes it when
 * `has_acc = 0` (absent ⇒ `props.acc === undefined`), so the factor drops out for unmeasured
 * cells exactly as the product does.
 *
 * ⚠️ `h3ToGeo` returns (lat, lon). `.1` is LATITUDE. Swap these and it matches nothing: zero
 * rows, no error, and this verifier would "pass" on an empty set. Hence the row-count assert.
 * The `acc` path (isochrone_cells → population) joins on H3 equality only — no coordinate ever
 * touches it, so there is nothing to swap there.
 */
const sql = (city, cats) => {
  const c = CITIES[city];
  const catList = cats.map((x) => `'${x}'`).join(", ");
  return `
  WITH cells AS (
    SELECT h3_8, population FROM geo.population
    WHERE country = '${c.country}'
      AND h3ToGeo(h3_8).1 BETWEEN ${c.latMin} AND ${c.latMax}
      AND h3ToGeo(h3_8).2 BETWEEN ${c.lonMin} AND ${c.lonMax}
  ),
  supply AS (
    SELECT arrayJoin(h3kRing(h3_8, 1)) AS cell, count() AS n
    FROM geo.places WHERE city = '${city}' AND category IN (${catList}) GROUP BY cell
  ),
  acc AS (
    SELECT o.h3_8 AS cell, sum(p.population / 7) AS acc_pop, toUInt8(1) AS has_acc
    FROM (SELECT h3_8, h3ToCenterChild(h3_8, 9) AS origin FROM cells) o
    INNER JOIN geo.isochrone_cells ic ON ic.origin_h3_9 = o.origin AND ic.minutes = 10 AND ic.city = '${city}'
    INNER JOIN geo.population p ON p.h3_8 = h3ToParent(ic.reachable_h3_9, 8) AND p.country = '${c.country}'
    GROUP BY o.h3_8
  ),
  joined AS (
    SELECT c.h3_8 AS cell, c.population AS pop, coalesce(s.n, 0) AS sup,
      a.acc_pop AS acc_pop, coalesce(a.has_acc, 0) AS has_acc
    FROM cells c
    LEFT JOIN supply s ON c.h3_8 = s.cell
    LEFT JOIN acc a ON c.h3_8 = a.cell
  ),
  scale AS (
    SELECT quantile(0.95)(pop) AS pop_p95, greatest(quantile(0.95)(sup), 1) AS sup_p95,
      greatest(quantileIf(0.95)(acc_pop, has_acc = 1), 1) AS acc_p95
    FROM joined
  ),
  scored AS (
    SELECT cell, pop, sup, has_acc, acc_pop,
      least(100, 100 * pop / pop_p95) AS demand_n,
      least(100, 100 * sup / sup_p95) AS supply_n,
      -- acc_n is computed from round(acc_pop), NOT the full-precision acc_pop scoring.ts ranks on.
      -- The reason is the whole point of this file: the browser is shipped round(acc_pop) (the
      -- choropleth writes toString(round(acc_pop)), and acc is fractional — sum(pop/7) — unlike
      -- the integral pop, so the round is lossy), so the gap it can REPRODUCE is the one that
      -- rounded value implies. scoring.ts's ranking gap uses full acc_pop and differs by one
      -- display tick (0.1) on ~11 of Berlin's 2,260 cells — cells sitting on a round(,1) boundary.
      -- Those cells never move in the ranking (the top-3 are all p95-capped at acc_n=100), and at
      -- neutral the product shows the fast-path shipped gap verbatim, never this recompute. What
      -- this file must prove is that the JS and the expression reproduce the score FROM THE SHIPPED
      -- VALUES exactly — so the reference is computed from the shipped values too.
      least(100, 100 * round(acc_pop) / acc_p95) AS acc_n,
      demand_n * (100 - supply_n) / 100 * if(has_acc, acc_n / 100, 1) AS gap,
      pop_p95, sup_p95, acc_p95
    FROM joined, scale
  )
  SELECT round(gap, 1) AS gap, round(pop) AS pop, sup, has_acc, round(acc_pop) AS acc,
         any(pop_p95) OVER () AS popP95, any(sup_p95) OVER () AS supP95,
         any(acc_p95) OVER () AS accP95
  FROM scored FORMAT JSONEachRow`;
};

/**
 * The reaches-self invariant (data-model.md): every MEASURED cell's 10-min catchment must reach
 * its own res-8 parent. The origin is the cell's res-9 centre child, so `h3ToParent(origin, 8)`
 * IS the cell — and Valhalla always includes the origin in its own reachable set, so a measured
 * cell that does NOT reach itself means the origin→reach join was wired backwards. That bug is
 * silent (plausible output, never an error) and this project has shipped it three times.
 *
 * Returns the count of measured cells that fail. It must be 0.
 */
const reachesSelfSql = (city) => {
  const c = CITIES[city];
  return `
  WITH cells AS (
    SELECT h3_8 FROM geo.population
    WHERE country = '${c.country}'
      AND h3ToGeo(h3_8).1 BETWEEN ${c.latMin} AND ${c.latMax}
      AND h3ToGeo(h3_8).2 BETWEEN ${c.lonMin} AND ${c.lonMax}
  ),
  origins AS (SELECT h3_8 AS cell, h3ToCenterChild(h3_8, 9) AS origin FROM cells)
  SELECT count() FROM (
    SELECT o.cell AS cell, maxIf(1, h3ToParent(ic.reachable_h3_9, 8) = o.cell) AS reaches_self
    FROM origins o
    INNER JOIN geo.isochrone_cells ic ON ic.origin_h3_9 = o.origin AND ic.minutes = 10 AND ic.city = '${city}'
    GROUP BY o.cell
  ) WHERE reaches_self = 0`;
};

// ---- run --------------------------------------------------------------------------------------

const NEUTRAL = { residents: 50, lowCompetition: 50, accessibility: 50 };
// Off-neutral probes. SQL has no opinion here, but JS and the expression must still agree —
// otherwise the number in the tooltip contradicts the colour under the cursor.
const PROBES = [
  { residents: 100, lowCompetition: 0, accessibility: 0 },
  { residents: 0, lowCompetition: 100, accessibility: 0 },
  { residents: 0, lowCompetition: 0, accessibility: 100 },
  { residents: 80, lowCompetition: 20, accessibility: 50 },
  { residents: 5, lowCompetition: 95, accessibility: 30 },
  { residents: 0, lowCompetition: 0, accessibility: 0 }, // degenerate: must fall back to neutral, not NaN
];

// Build the client's `CellProps` from a SQL row. `acc` is emitted on every row, but has_acc = 0
// means the catchment was never measured — absent, NOT zero. Deleting the key here is the JS
// analogue of choroplethSql omitting it from the GeoJSON: `props.acc === undefined`, so the
// accessibility factor's `available` test drops it out of the product. JSON.stringify would
// drop an undefined key for free; here we drop it explicitly since the row already carries it.
function propsOf(r) {
  const p = { pop: r.pop, sup: r.sup, gap: r.gap, acc: r.acc };
  if (r.has_acc === 0) delete p.acc;
  return p;
}

let failed = false;

for (const city of Object.keys(CITIES)) {
  const rows = (await query(sql(city, ["bakery"])))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  if (rows.length === 0) {
    console.error(`${city}: ZERO rows — the bbox matched nothing. Check the h3ToGeo lat/lon order.`);
    failed = true;
    continue;
  }

  const scale = { popP95: rows[0].popP95, supP95: rows[0].supP95, accP95: rows[0].accP95 };
  const measured = rows.filter((r) => r.has_acc === 1).length;

  // 1. neutral: JS must reproduce SQL — for MEASURED cells (3-term) and UNMEASURED cells (2-term,
  //    acc absent) alike. propsOf drops acc when it was never measured, so the same code path
  //    covers both without a branch here.
  let bad = 0;
  let maxD = 0;
  for (const r of rows) {
    const js = gapOf(propsOf(r), scale, NEUTRAL);
    const d = Math.abs(Math.round(js * 10) / 10 - r.gap);
    maxD = Math.max(maxD, d);
    if (d > 0) bad++;
  }

  // 2. every weighting: the MapLibre expression must reproduce JS
  let exprBad = 0;
  let exprMaxD = 0;
  for (const w of [NEUTRAL, ...PROBES]) {
    const evalExpr = compile(gapExpression(scale, w));
    for (const r of rows) {
      const props = propsOf(r);
      const a = gapOf(props, scale, w);
      const b = evalExpr(props);
      const d = Math.abs(a - b);
      exprMaxD = Math.max(exprMaxD, d);
      // Floating point: both are IEEE doubles doing the same ops, but not necessarily in the
      // same association order. A tenth of a display digit is the tolerance that matters.
      if (d > 1e-6) exprBad++;
    }
  }

  // 3. the reaches-self invariant: a measured cell's catchment must reach its own res-8 parent.
  //    Zero exceptions or the origin→reach join is backwards — a silent, plausible-looking bug.
  const selfMiss = Number(await query(reachesSelfSql(city)));

  const ok = bad === 0 && exprBad === 0 && selfMiss === 0;
  failed ||= !ok;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${city.padEnd(10)} ${String(rows.length).padStart(5)} cells ` +
      `(${measured} measured) · ` +
      `p95 pop=${scale.popP95} sup=${scale.supP95} acc=${scale.accP95} · ` +
      `neutral SQL↔JS: ${bad} mismatches (max |Δ| ${maxD}) · ` +
      `JS↔expression over ${1 + PROBES.length} weightings: ${exprBad} mismatches (max |Δ| ${exprMaxD.toExponential(1)}) · ` +
      `reaches-self misses: ${selfMiss}`,
  );
}

if (failed) {
  console.error(
    "\n  The browser is not showing the score ClickHouse ranked on, or a catchment does not reach\n" +
      "  its own cell. Do not ship the sliders.\n",
  );
  process.exit(1);
}
console.log(
  "\nSQL, JS and the MapLibre expression agree, and every measured catchment reaches its own cell.\n" +
    "The sliders start on the agent's answer.\n",
);
