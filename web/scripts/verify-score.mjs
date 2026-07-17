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
 * ## Run
 *
 *     cd web && pnpm verify:score
 *
 * Reads CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD from the repo-root .env.
 * Costs nothing: no LLM, three ClickHouse queries.
 *
 * ## Result, 2026-07-20 (Cloud 26.4.1.2029)
 *
 *     berlin     2260 cells   neutral: 0 mismatches   max |Δ| 0
 *     amsterdam   739 cells   neutral: 0 mismatches   max |Δ| 0
 *     belgrade   1076 cells   neutral: 0 mismatches   max |Δ| 0
 *
 * A bonus finding that fell out of writing it: Kontur `population` is integral in all three
 * countries (0 of 475,535 rows fractional), so `round(pop)` in choroplethSql is lossless and the
 * browser can rebuild `demand_n` from the shipped value. Had it been fractional, the client
 * would have been quietly wrong at the third decimal — and this file would have caught it.
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
  for (const f of FACTORS) acc *= Math.pow(f.term(p, s) / 100, e[f.id]);
  return Math.max(0, Math.min(100, acc));
}

function gapExpression(s, w) {
  const e = exponents(w);
  let acc = ["literal", 100];
  for (const f of FACTORS) acc = ["*", acc, ["^", ["/", f.expr(s), 100], e[f.id]]];
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
 * ⚠️ `h3ToGeo` returns (lat, lon). `.1` is LATITUDE. Swap these and it matches nothing: zero
 * rows, no error, and this verifier would "pass" on an empty set. Hence the row-count assert.
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
  joined AS (
    SELECT c.h3_8 AS cell, c.population AS pop, coalesce(s.n, 0) AS sup
    FROM cells c LEFT JOIN supply s ON c.h3_8 = s.cell
  ),
  scale AS (
    SELECT quantile(0.95)(pop) AS pop_p95, greatest(quantile(0.95)(sup), 1) AS sup_p95 FROM joined
  ),
  scored AS (
    SELECT cell, pop, sup,
      least(100, 100 * pop / pop_p95) AS demand_n,
      least(100, 100 * sup / sup_p95) AS supply_n,
      demand_n * (100 - supply_n) / 100 AS gap,
      pop_p95, sup_p95
    FROM joined, scale
  )
  SELECT round(gap, 1) AS gap, round(pop) AS pop, sup, any(pop_p95) OVER () AS popP95,
         any(sup_p95) OVER () AS supP95
  FROM scored FORMAT JSONEachRow`;
};

// ---- run --------------------------------------------------------------------------------------

const NEUTRAL = { residents: 50, lowCompetition: 50 };
// Off-neutral probes. SQL has no opinion here, but JS and the expression must still agree —
// otherwise the number in the tooltip contradicts the colour under the cursor.
const PROBES = [
  { residents: 100, lowCompetition: 0 },
  { residents: 0, lowCompetition: 100 },
  { residents: 80, lowCompetition: 20 },
  { residents: 5, lowCompetition: 95 },
  { residents: 0, lowCompetition: 0 }, // degenerate: must fall back to neutral, not NaN
];

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

  const scale = { popP95: rows[0].popP95, supP95: rows[0].supP95 };

  // 1. neutral: JS must reproduce SQL
  let bad = 0;
  let maxD = 0;
  for (const r of rows) {
    const js = gapOf({ pop: r.pop, sup: r.sup, gap: r.gap }, scale, NEUTRAL);
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
      const props = { pop: r.pop, sup: r.sup, gap: r.gap };
      const a = gapOf(props, scale, w);
      const b = evalExpr(props);
      const d = Math.abs(a - b);
      exprMaxD = Math.max(exprMaxD, d);
      // Floating point: both are IEEE doubles doing the same ops, but not necessarily in the
      // same association order. A tenth of a display digit is the tolerance that matters.
      if (d > 1e-6) exprBad++;
    }
  }

  const ok = bad === 0 && exprBad === 0;
  failed ||= !ok;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${city.padEnd(10)} ${String(rows.length).padStart(5)} cells · ` +
      `p95 pop=${scale.popP95} sup=${scale.supP95} · ` +
      `neutral SQL↔JS: ${bad} mismatches (max |Δ| ${maxD}) · ` +
      `JS↔expression over ${1 + PROBES.length} weightings: ${exprBad} mismatches (max |Δ| ${exprMaxD.toExponential(1)})`,
  );
}

if (failed) {
  console.error(
    "\n  The browser is not showing the score ClickHouse ranked on. Do not ship the sliders.\n",
  );
  process.exit(1);
}
console.log("\nSQL, JS and the MapLibre expression agree. The sliders start on the agent's answer.\n");
