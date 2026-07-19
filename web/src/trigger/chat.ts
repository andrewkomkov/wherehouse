import { chat, ai } from "@trigger.dev/sdk/ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText, stepCountIs, tool } from "ai";
import type { InferUITools, UIMessage } from "ai";
import { createClient } from "@clickhouse/client";
import { z } from "zod";
import { emitLayer, type MapData, type BBox, type LayerId } from "./layers";
import { upsertShortlist, insertSavedSite } from "../lib/pg";
import {
  CITIES,
  isCity,
  competitorsSql,
  bboxSql,
  choroplethSql,
  choroplethStatsSql,
  rankSql,
  catchmentSql,
  catchmentStatsSql,
  savedSitesRowsSql,
  savedSitesGeoJsonSql,
  affinityForCellsSql,
  categoryTrendSql,
  type CityName,
} from "./scoring";

// DeepSeek speaks the Anthropic wire format, so @ai-sdk/anthropic works unchanged
// apart from baseURL. Drop ANTHROPIC_BASE_URL to fall back to Anthropic proper.
const model = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
})(process.env.LLM_MODEL ?? "claude-sonnet-4-5");

const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_USER,
  password: process.env.CLICKHOUSE_PASSWORD,
});

/**
 * The historical-momentum series behind the sparkline (Feature 004). Rides its own `data-trend`
 * part to the client (ADR-001) so the full ~54-point series never touches the model context —
 * the tool hands the model only { direction, pctChange, fromYear }.
 *
 * ⚠️ RELATIVE momentum from OSM edit history, never an exhaustive absolute count — see
 * categoryTrendSql. `pctChange` is null when history is too thin to divide, and `enoughHistory`
 * is false with an empty `monthly` for a trade the loader never fetched (absent ≠ 0): the client
 * renders "not enough history", never a fabricated flat-at-zero line. `fromYear` is the real start
 * year of the series (~2022), so the window is stated truthfully — it spans MORE than three years,
 * and calling it "3Y" was a false claim (constitution II).
 */
type TrendData = {
  city: string;
  category: string;
  direction: "rising" | "flat" | "saturating";
  pctChange: number | null;
  fromYear: number;
  enoughHistory: boolean;
  monthly: { month: string; count: number }[];
};

/**
 * A one-shot UI command (Feature 006): the agent driving the browser's own UI state through the
 * same setters the buttons use. Unlike `data-map` (a stateful layer updated in place by a STABLE
 * id), each `data-ui` command carries a UNIQUE id — the client keeps an `appliedUi` set so a
 * command applies exactly once, even across re-renders and reconnects (ADR-001 discipline).
 *
 * The model only ever sees `{ ok: true, action }` back; the full effect happens client-side and
 * never re-enters the model context (same bypass as `data-map`). `reweight` names only the three
 * REAL factors — residents, competition, accessibility — because those are the only ones there is
 * data for; there is no "rent" factor and one must never be invented (see components/score.ts).
 */
export type UiCommand =
  | { action: "setLayer"; layer: LayerId; on: boolean }
  | { action: "reweight"; residents?: number; competition?: number; accessibility?: number }
  | { action: "focusPick"; rank: number }
  | { action: "highlightExtreme"; extreme: "worst" | "best" }
  | { action: "reviewRun"; n: number }
  | { action: "exportReport" };

// NB: do NOT write `UIDataTypes & { map: MapData }` as the docs example does.
// UIDataTypes is Record<string, unknown>, so intersecting widens keyof to
// `string` — the part type degrades to `data-${string}` with `data: unknown`
// and the client loses all narrowing. Declare the parts bare instead.
type WhereHouseDataTypes = { map: MapData; trend: TrendData; ui: UiCommand };

/**
 * The demo questions ask for trades, not for Overture taxonomy strings. This maps one to the
 * other. Deliberately a lookup and not an LLM taxonomy mapper: it answers every question we
 * demo, and inference would be a day of work for zero rubric points.
 *
 * Only the trades that shine end-to-end are exposed: real Overture POI in all three demo cities
 * (Berlin/Amsterdam/Belgrade), an editorial affinity target (F5), and a historical trend (F3).
 * kindergarten (no POI), bar/pub (no affinity target) and fast_food (no POI) are deliberately
 * left off the model's surface — their ClickHouse data stays, we just don't offer them.
 *
 * A group (several categories) is how a question gets wide enough to exceed the stream cap —
 * which is the point of User Story 2, not an accident. The group is built ONLY from shining
 * trades (restaurant + cafe + bakery) and is still wide enough to take the handle path in all
 * three cities.
 */
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  bakery: ["bakery"],
  bakeries: ["bakery"],
  pharmacy: ["pharmacy"],
  pharmacies: ["pharmacy"],
  cafe: ["cafe"],
  coffee: ["cafe"],
  restaurant: ["restaurant"],
  restaurants: ["restaurant"],
  supermarket: ["supermarket"],
  gym: ["gym"],
  dentist: ["dentist"],
  dentists: ["dentist"],
  "hair salon": ["hair_salon"],
  "hair salons": ["hair_salon"],
  hairdresser: ["hair_salon"],
  hotel: ["hotel"],
  hotels: ["hotel"],
  "food and drink": ["restaurant", "cafe", "bakery"],
  "food & drink": ["restaurant", "cafe", "bakery"],
};

function resolveCategories(input: string): string[] {
  const key = input.trim().toLowerCase();
  return CATEGORY_SYNONYMS[key] ?? [key];
}

const target = z.object({
  city: z.string().describe("berlin, amsterdam or belgrade"),
  // The model can only pick a group it has been told exists. Listing the keys here is not
  // decoration: asked for "all food and drink", it otherwise falls back to the nearest
  // single category it has seen ("restaurant") and quietly answers a narrower question than
  // the user asked.
  category: z
    .string()
    .describe(
      `the trade. One of: ${Object.keys(CATEGORY_SYNONYMS).join(", ")}. ` +
        `"food and drink" is a GROUP covering restaurants, cafes and bakeries — ` +
        `use it when the user asks broadly about eating and drinking rather than one trade.`,
    ),
});

/**
 * Rejects a city we hold no data for.
 *
 * Returning an error the agent can relay is deliberate: the alternative is rendering an
 * empty map, which reads as "nowhere is good" — a confident lie. (FR-005)
 */
function checkCity(city: string): { ok: true; city: CityName } | { ok: false; err: object } {
  const c = city.trim().toLowerCase();
  if (isCity(c)) return { ok: true, city: c };
  return {
    ok: false,
    err: { error: "unavailable", available: Object.keys(CITIES) },
  };
}

/**
 * A query whose single row/column is already a GeoJSON string.
 *
 * `TabSeparatedRaw` emits the value with no escaping, which is what we want: the client has
 * no `RawBLOB`, and any JSON format would re-escape a 549 KiB string only for us to unescape
 * it again. Safe here because `toJSONString` escapes tabs and newlines inside the JSON, so
 * the payload can never contain a raw separator.
 */
async function queryText(sql: string): Promise<string> {
  const rs = await clickhouse.query({ query: sql, format: "TabSeparatedRaw" });
  return (await rs.text()).trim();
}

async function queryRows<T>(sql: string): Promise<T[]> {
  const rs = await clickhouse.query({ query: sql, format: "JSONEachRow" });
  return await rs.json<T>();
}

const findCompetitors = tool({
  description:
    "Show the existing competitors for a trade in a city as dots on the map. Call this first when the user asks where to open something, and whenever they ask to see businesses of a kind.",
  inputSchema: target,
  execute: async ({ city, category }) => {
    const c = checkCity(city);
    if (!c.ok) return c.err;
    const cats = resolveCategories(category);

    const [geojsonText, box] = await Promise.all([
      queryText(competitorsSql(c.city, cats)),
      queryRows<{ minLon: number; minLat: number; maxLon: number; maxLat: number }>(
        bboxSql(c.city, cats),
      ),
    ]);

    const features = JSON.parse(geojsonText).features as unknown[];
    if (features.length === 0) {
      return { error: "no data for that category", city: c.city, category };
    }

    const b = box[0];
    const bbox: BBox | undefined =
      b && b.minLon != null ? [b.minLon, b.minLat, b.maxLon, b.maxLat] : undefined;

    return await emitLayer(clickhouse, {
      layer: "competitors",
      label: `${features.length.toLocaleString("en")} ${category} in ${c.city}`,
      geojsonText,
      rowCount: features.length,
      bbox,
    });
  },
});

const scoreArea = tool({
  description:
    "Compute and show the opportunity surface: every populated area of the city coloured by how underserved it is. Call this after findCompetitors.",
  inputSchema: target,
  execute: async ({ city, category }) => {
    const c = checkCity(city);
    if (!c.ok) return c.err;
    const cats = resolveCategories(category);

    const [geojsonText, stats] = await Promise.all([
      queryText(choroplethSql(c.city, cats)),
      queryRows<{
        cellCount: number;
        topGap: number;
        medianGap: number;
        popP95: number;
        supP95: number;
        accP95: number;
        notMeasured: number;
      }>(choroplethStatsSql(c.city, cats)),
    ]);

    const s = stats[0];
    // ~549 KiB for Berlin ⇒ this always takes the handle path. That is deliberate: the
    // mitigation runs on the primary demo's own layer, so it cannot rot unnoticed.
    await emitLayer(clickhouse, {
      layer: "opportunity",
      label: `opportunity for ${category} across ${c.city}`,
      geojsonText,
      rowCount: s?.cellCount ?? 0,
      // For the browser's re-weight sliders only — never for the model (it is not in the return
      // below). These are the scalars this query actually normalised with, so the client-side
      // score lands on the agent's own ranking at neutral instead of near it. See layers.ts.
      scale:
        s && s.popP95 > 0 ? { popP95: s.popP95, supP95: s.supP95, accP95: s.accP95 } : undefined,
      // Only the opportunity layer carries scoreable cells, so it is the only one that reports
      // how many of them went unmeasured (absent != 0 — the count of has_acc=0, not a zero fill).
      notMeasured: s?.notMeasured,
    });

    return { cellCount: s?.cellCount ?? 0, topGap: s?.topGap ?? 0, medianGap: s?.medianGap ?? 0 };
  },
});

type Pick = {
  h3: string;
  gap: number;
  pop: number;
  sup: number;
  lon: number;
  lat: number;
  /**
   * The two name tiers from geo.districts, resolved by point-in-polygon against Overture
   * divisions at load time — see db/clickhouse/005_districts_schema.sql.
   *
   * Named after what Overture means, NOT after Berlin: `locality` is a Bezirk inside Berlin but
   * a Gemeinde in Brandenburg, a municipality in NL and a village in RS. `area` is the finer tier
   * (Berlin Ortsteil, Amsterdam stadsdeel) and has no equivalent in most of Belgrade.
   *
   * **`''` means we have no name for that cell.** Measured coverage 2026-07-20 — locality
   * 98.3/100/100 %, area 56.8/47.8/**3.9** % for berlin/amsterdam/belgrade. So in Belgrade
   * `area` is almost always empty and locality-only is the normal answer, not a broken one.
   * Empty must stay empty all the way to the model and the popup; `placeName` below is the only
   * place that decides what to do with it.
   */
  area: string;
  locality: string;
};

/**
 * The one function allowed to turn a pick into a place name.
 *
 * Returns `undefined` rather than a fallback when nothing resolved. That is the entire point of
 * the day-3 fix: an unnamed cell produces NO name, never the nearest district. `undefined` drops
 * the key from the JSON the model sees and from the GeoJSON properties, so a missing name is
 * invisible rather than empty-stringy — the model cannot mistake `""` for a name it should fill in.
 *
 * Exported only so this rule can be executed directly rather than re-implemented in a check: a
 * check that reimplements the logic it is checking verifies the reimplementation, not the code
 * that ships (constitution II).
 */
export function placeName(p: Pick): string | undefined {
  const parts = [p.area, p.locality].filter((n) => n !== "");
  // Both present and different ⇒ "Lichtenrade, Tempelhof-Schöneberg". Either alone is still a
  // true statement — and locality-alone is the NORMAL Belgrade answer ("Zvezdara"), because
  // Overture has 3 macrohoods for that whole bbox. That path is the common one, not a fallback.
  //
  // The dedup is not defensive coding — an area is legitimately named the same as its parent
  // locality, and it is common: measured 2026-07-20, area = locality in 82 Berlin cells
  // (Neukölln is both an Ortsteil and the Bezirk containing it), 26 Amsterdam cells (Weesp) and
  // 2 in Belgrade. Without this, those cells would render "Neukölln, Neukölln".
  const uniq = [...new Set(parts)];
  return uniq.length > 0 ? uniq.join(", ") : undefined;
}

const rankSites = tool({
  description:
    "Pin the three best places to open. Call this last. The pins carry the population and competitor count behind each score.",
  inputSchema: target,
  execute: async ({ city, category }) => {
    const c = checkCity(city);
    if (!c.ok) return c.err;
    const cats = resolveCategories(category);

    const picks = await queryRows<Pick>(rankSql(c.city, cats, 3));
    if (picks.length === 0) {
      return { error: "no populated cells for that city", city: c.city };
    }

    // EDITORIAL neighbourhood-fit for the picks — a labelled heuristic, NEVER the measured GAP
    // rank (that stays demand × (100 − supply) × accessibility; the picks are already ordered).
    // `cats[0]` is the primary trade: cats === resolveCategories(category), and a GROUP with no
    // single target (e.g. "food and drink") falls back to its first category, per the dict's own
    // fallback contract in db/clickhouse/007_affinity.sql.
    const resolvedTarget = cats[0];
    const affinity = await queryRows<{ h3: string; fit: number; topNeighbours: string }>(
      affinityForCellsSql(c.city, resolvedTarget, picks.map((p) => p.h3)),
    );
    // absent != 0: a pick whose ring holds no complementary trade comes back fit 0 / '[]'. We key
    // presence on a NON-EMPTY neighbour list, so such a pick gets NO fit keys at all — the UI and
    // the model then render "none nearby", never a measured "fit = 0" (FR-006).
    const affinityByH3 = new Map(
      affinity.map((a) => {
        const neighbours = JSON.parse(a.topNeighbours) as { category: string; n: number; w: number }[];
        return [a.h3, { fit: a.fit, neighbours }];
      }),
    );

    const geojson = {
      type: "FeatureCollection",
      features: picks.map((p, i) => {
        const a = affinityByH3.get(p.h3);
        const hasFit = a != null && a.neighbours.length > 0;
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [p.lon, p.lat] },
          // `place` is what the popup shows as its heading. Undefined when the cell resolved to no
          // district — JSON.stringify drops the key entirely, so the popup renders without a
          // heading rather than with an empty one. `fit`/`topNeighbours` are the EDITORIAL signal
          // for the client to render (labelled editorial there); omitted when none nearby.
          properties: {
            rank: i + 1,
            gap: p.gap,
            pop: p.pop,
            sup: p.sup,
            h3: p.h3,
            place: placeName(p),
            ...(hasFit ? { fit: a.fit, topNeighbours: a.neighbours } : {}),
          },
        };
      }),
    };

    await emitLayer(clickhouse, {
      layer: "picks",
      label: `top ${picks.length} for ${category} in ${c.city}`,
      geojsonText: JSON.stringify(geojson),
      rowCount: picks.length,
    });

    // The one tool whose result the model may legitimately mention: FR-003 wants the user to
    // see the numbers behind each pick. Even so the MAP carries them — this is the garnish.
    //
    // `place` is the only place name the model is ever allowed to utter, and it is only here
    // because a point-in-polygon test put the cell inside that polygon. Where it is absent the
    // key is absent — the model has nothing to relay and the prompt forbids inventing one.
    return {
      picks: picks.map((p, i) => {
        const a = affinityByH3.get(p.h3);
        const hasFit = a != null && a.neighbours.length > 0;
        return {
          rank: i + 1,
          place: placeName(p),
          gap: p.gap,
          population: p.pop,
          competitorsNearby: p.sup,
          // EDITORIAL, not measured, and NOT part of the score — the model MAY relay these as a
          // complementary aside (see SYSTEM_PROMPT). Omitted when no complementary trade is
          // nearby, so the model has nothing to relay and cannot narrate an absence as "fit 0".
          //
          // The model gets the trade NAMES only, never the raw `fit` number. The number is an
          // editorial heuristic that reads like a score; handing it to the model invites it to
          // quote "neighbourhood fit 10.8" as if it were measured — the FR-004 failure. The UI
          // shows the number behind an explicit "editorial" tag; the model, which has no such
          // affordance, never sees it. `fit` stays in the picks GeoJSON properties for the UI.
          ...(hasFit ? { complementaryNearby: a.neighbours.map((nb) => nb.category) } : {}),
        };
      }),
    };
  },
});

const showCatchment = tool({
  description:
    "Show the real measured walk catchment around the best place to open — the area a customer can actually reach on foot in 10 minutes, following streets. Call this after rankSites.",
  inputSchema: target,
  execute: async ({ city, category }) => {
    const c = checkCity(city);
    if (!c.ok) return c.err;
    const cats = resolveCategories(category);

    // Re-derive pick #1 from the same total order rankSites ranked on, rather than taking an h3
    // from the model. rankSql is deterministic (FR-004), so this lands on the identical cell —
    // and an h3 threaded through the model is a hallucination surface bought for nothing (D5).
    const picks = await queryRows<Pick>(rankSql(c.city, cats, 1));
    if (picks.length === 0) {
      return { error: "no populated cells for that city", city: c.city };
    }
    const pick = picks[0];

    const [stats] = await queryRows<{ lobes: number; reachablePeople: number }>(
      catchmentStatsSql(c.city, pick.h3),
    );

    // No walkable edge within 150 m of the cell centre ⇒ nothing routed. Emit NOTHING to the map
    // (a drawn nothing and an undrawn nothing are different claims — US1 AS3) and hand the model a
    // reason, not an empty success it could narrate as a catchment that isn't there.
    if (!stats || stats.lobes === 0) {
      return {
        catchment: "not measured",
        reason: "no walkable edge within 150 m of the cell centre",
      };
    }

    const geojsonText = await queryText(catchmentSql(c.city, pick.h3));
    await emitLayer(clickhouse, {
      layer: "catchment",
      label: "10-minute walk from the top pick",
      geojsonText,
      rowCount: stats.lobes,
    });

    // reachablePeople is the ONE number in this product the model may call a walk — Valhalla
    // measured it. minutes/lobes ride along; the geometry stays on the map (ADR-001).
    return { minutes: 10, reachablePeople: stats.reachablePeople, lobes: stats.lobes };
  },
});

// The user is `u1` everywhere in this demo — there is no auth yet, and the write side
// (db/postgres/001_oltp_schema.sql) keys sites on it. One place so it cannot drift.
const DEMO_USER_ID = "u1";

/**
 * The shortlist's chat scope when we cannot recover the real chatId.
 *
 * `ai.chatContext()` reads it from the run's tool metadata, which is only populated when a tool
 * runs as a subtask (`ai.toolExecute`). These tools run INLINE in the agent run, so it returns
 * undefined and this constant is what upsertShortlist keys on. The one visible effect: every save
 * for the same (user, city, business_type) lands under ONE shortlist regardless of conversation,
 * which is the right behaviour for a single-user demo and wrong for multi-tenant — a real product
 * would thread the chatId through. Not invented data, just a coarser grouping. (constitution II —
 * stated as the limitation it is, not dressed up as per-chat isolation we did not build.)
 */
const SAVE_CHAT_SCOPE = "wherehouse-demo";

const saveSite = tool({
  description:
    "Save one of the ranked picks to the user's shortlist so they can compare it against the market later. Use when the user asks to save/keep/shortlist a pick.",
  inputSchema: target.extend({
    which: z
      .enum(["1", "2", "3"])
      .default("1")
      .describe("which ranked pick to save: '1' is the best, then '2', then '3'. Defaults to the best."),
  }),
  execute: async ({ city, category, which }) => {
    const c = checkCity(city);
    if (!c.ok) return c.err;
    const cats = resolveCategories(category);

    // Re-derive the picks from the same deterministic ranking rankSites showed (FR-004), rather
    // than trusting a model-supplied h3/score — the model never sees the geometry (ADR-001) and a
    // threaded h3 is a hallucination surface bought for nothing. `which` only chooses among them.
    const picks = await queryRows<Pick>(rankSql(c.city, cats, 3));
    const pick = picks[Number(which) - 1];
    if (!pick) {
      return { error: "no such pick to save", city: c.city, category, which };
    }

    const label = placeName(pick) ?? "saved site";
    const chatId = ai.chatContext()?.chatId ?? SAVE_CHAT_SCOPE;
    const shortlistId = await upsertShortlist({
      chatId,
      userId: DEMO_USER_ID,
      city: c.city,
      businessType: category,
      title: `${category} in ${c.city}`,
    });
    await insertSavedSite({
      shortlistId,
      userId: DEMO_USER_ID,
      label,
      lon: pick.lon,
      lat: pick.lat,
      h3_8: pick.h3,
      score: pick.gap,
    });

    // No map layer: the pin is already on screen from rankSites. Just a small confirmation the
    // model may relay — the label came from a tool, so it is safe to say (see SYSTEM_PROMPT).
    return { saved: label, rank: which, status: "candidate" };
  },
});

const compareSavedSites = tool({
  description:
    "Compare the user's saved sites against today's market — re-score each saved site on the current GAP surface and show them on the map. Use when the user asks how their saved/kept sites compare.",
  inputSchema: target,
  execute: async ({ city, category }) => {
    const c = checkCity(city);
    if (!c.ok) return c.err;
    const cats = resolveCategories(category);

    // The summary drives the early return: no saved sites ⇒ emit NOTHING (a drawn empty layer is a
    // different claim than no layer at all) and tell the model the count, not a fake success.
    const rows = await queryRows<{
      label: string;
      // market_gap/residents/rivals come back null for a site outside today's scored set (a LEFT
      // JOIN miss). null is "unscored", never 0 (FR-006) — marketGap is then dropped from the model
      // payload, so the model has no number to relay and cannot narrate an absent score as a real one.
      market_gap: number | null;
      residents: number | null;
      rivals: number | null;
      status: string;
    }>(savedSitesRowsSql(c.city, cats, DEMO_USER_ID));

    if (rows.length === 0) {
      return { savedSites: 0 };
    }

    const geojsonText = await queryText(savedSitesGeoJsonSql(c.city, cats, DEMO_USER_ID));
    await emitLayer(clickhouse, {
      layer: "saved",
      label: `${rows.length} saved ${category} ${rows.length === 1 ? "site" : "sites"} in ${c.city}`,
      geojsonText,
      rowCount: rows.length,
    });

    // ADR-001: the map carries the geometry, the model sees only this summary.
    return {
      sites: rows.map((r) => ({
        label: r.label,
        // Omitted when unscored — absent != 0. Present only when today's surface scored the cell.
        ...(r.market_gap != null ? { marketGap: r.market_gap } : {}),
        residents: r.residents,
        rivals: r.rivals,
        status: r.status,
      })),
    };
  },
});

const categoryTrend = tool({
  description:
    "Show how a trade's numbers have moved over recent years as a sparkline — is this market rising, flat, or saturating? Historical momentum the static GAP snapshot cannot see. Call this after the map tools when the user asks where to open something.",
  inputSchema: target,
  execute: async ({ city, category }) => {
    const c = checkCity(city);
    if (!c.ok) return c.err;
    // The trend is measured for ONE trade, not a group: cats[0] is the primary target — the same
    // fallback affinityForCellsSql uses. A group like "food and drink" trends on "restaurant".
    const cat = resolveCategories(category)[0];

    // categoryTrendSql returns a single JSON-string column (26.4 has no GeoJSON/JSON row format),
    // so read it raw and parse — same shape as the GeoJSON tools above.
    const row = JSON.parse(await queryText(categoryTrendSql(c.city, cat))) as Omit<
      TrendData,
      "city" | "category"
    >;

    // absent != 0: a trade the loader never fetched comes back enoughHistory=false with an empty
    // series and null pctChange. Emit NOTHING to the sparkline (a drawn flat-at-zero line is a
    // different, false claim than no line) and hand the model a reason, not a fabricated trend
    // (FR-005). The prompt forbids the model inventing a direction from this.
    if (!row.enoughHistory) {
      return { trend: "not enough history", category: cat };
    }

    // ADR-001: the ~54-point series rides the data part to the client for the sparkline; the model
    // sees only the small summary below. Stable id 'trend' so a re-run updates the part in place
    // rather than appending (the same id-update mechanism as data-map in layers.ts).
    chat.response.write({
      type: "data-trend",
      id: "trend",
      data: { city: c.city, category: cat, ...row } satisfies TrendData,
    });

    // Model-facing: direction + the RELATIVE change and the true start year ONLY, never the series.
    // The prompt binds how these may be stated — relative OSM momentum since fromYear, never an
    // exhaustive absolute count and never a hardcoded "3 years" (the series is longer than that).
    return { direction: row.direction, pctChange: row.pctChange, sinceYear: row.fromYear };
  },
});

// -------------------------------------------------------------------------------------------
// Feature 006 — the agent operates the whole UI. Each tool below emits a one-shot `data-ui`
// command that the client applies through the SAME setter its buttons use, so agent-driven and
// hand-driven paths can never diverge. The model only ever gets `{ ok: true, action }` back.
// -------------------------------------------------------------------------------------------

/**
 * Write one `data-ui` command to the stream and return what the MODEL is allowed to see.
 *
 * The id is UNIQUE per command (unlike `data-map`'s stable layer id): a UI command is one-shot,
 * so a fresh id lets the client apply it exactly once and never "update it in place". The effect
 * lands entirely in the browser — the model just learns the action was issued.
 */
function emitUi(data: UiCommand): { ok: true; action: string } {
  chat.response.write({ type: "data-ui", id: crypto.randomUUID(), data });
  return { ok: true, action: data.action };
}

const clamp01to100 = (v: number): number => Math.max(0, Math.min(100, v));

const setLayer = tool({
  description:
    "Show or hide one map layer. Use when the user asks to hide/show/toggle a layer — e.g. 'hide the competitors', 'show the walk catchment again'. Layers: opportunity (the choropleth), competitors, picks, catchment (the 10-min walk), saved.",
  inputSchema: z.object({
    layer: z.enum(["opportunity", "competitors", "picks", "catchment", "saved"]),
    on: z.boolean().describe("true to show the layer, false to hide it"),
  }),
  execute: async ({ layer, on }) => emitUi({ action: "setLayer", layer, on }),
});

const reweight = tool({
  description:
    "Move the re-weight sliders that recolour the opportunity surface. There are ONLY three factors and each is 0–100: residents (Kontur population), competition (headroom vs rivals), accessibility (residents within a 10-min walk — 'walkability'). There is NO rent factor; never accept or invent one. Pass only the sliders the user asked to change. Use for 'weight walkability to the max', 'care more about residents', etc.",
  inputSchema: z.object({
    residents: z.number().optional().describe("0–100, Kontur resident demand"),
    competition: z.number().optional().describe("0–100, low-competition headroom"),
    accessibility: z.number().optional().describe("0–100, 10-min-walk accessibility"),
  }),
  execute: async ({ residents, competition, accessibility }) =>
    emitUi({
      action: "reweight",
      // Clamp defensively so an out-of-range value from the model can never send a slider past
      // its rail. Undefined stays undefined — an untouched factor is left where the user had it.
      ...(residents != null ? { residents: clamp01to100(residents) } : {}),
      ...(competition != null ? { competition: clamp01to100(competition) } : {}),
      ...(accessibility != null ? { accessibility: clamp01to100(accessibility) } : {}),
    }),
});

const focusPick = tool({
  description:
    "Open a ranked pick's provenance panel by rank (1 = best, then 2, then 3). Use when the user asks to open/see/focus a specific pick — e.g. 'open the #2 pick', 'show me the details of the top pick'.",
  inputSchema: z.object({ rank: z.number().int().min(1).max(3) }),
  execute: async ({ rank }) => emitUi({ action: "focusPick", rank }),
});

const highlightExtreme = tool({
  description:
    "Mark the single worst (lowest-opportunity) or best (highest-opportunity) SCORED cell on the current opportunity surface. The client finds it from the surface it already holds — no new query, no invented cell. Use for 'show me the worst place', 'where is the best cell'.",
  inputSchema: z.object({ extreme: z.enum(["worst", "best"]) }),
  execute: async ({ extreme }) => emitUi({ action: "highlightExtreme", extreme }),
});

const reviewRun = tool({
  description:
    "Rewind the map to a past agent run by its number (1 = the first run of this conversation). Use when the user asks to go back to an earlier answer — e.g. 'go back to the bakery answer', 'show me the first result again'.",
  inputSchema: z.object({ n: z.number().int().min(1).describe("the run number, 1-based") }),
  execute: async ({ n }) => emitUi({ action: "reviewRun", n }),
});

const exportReport = tool({
  description:
    "Build and download a one-page PDF report of the current answer — the map as shown, the top picks, the market-at-a-glance metrics and the provenance/honesty block. Use when the user asks to export, download, save or share a report or PDF.",
  inputSchema: z.object({}),
  execute: async () => emitUi({ action: "exportReport" }),
});

const tools = {
  findCompetitors,
  scoreArea,
  rankSites,
  showCatchment,
  saveSite,
  compareSavedSites,
  categoryTrend,
  setLayer,
  reweight,
  focusPick,
  highlightExtreme,
  reviewRun,
  exportReport,
};

/**
 * The system prompt, exported so the naming guard can be EXECUTED against a live model rather
 * than asserted in a comment.
 *
 * This block is the whole day-3 fix and it is shaped deliberately — do not flatten it back into
 * a blanket ban, and do not soften it into "prefer not to guess".
 */
export const SYSTEM_PROMPT = [
  "You are WhereHouse, a site-selection assistant. The map is the answer; your prose is not.",
  "For 'where should I open X in Y', call findCompetitors, then scoreArea, then rankSites, then showCatchment — in that order, so the map builds up as you work.",
  // Feature 006 — ACT, DON'T TALK. A request to change what is on screen is a TOOL CALL, not a
  // sentence: answering it with prose alone is the exact defect this feature fixes. Every such
  // request has a tool, and a UI or rebuild request must NEVER resolve as a pure-text turn.
  "When the user asks to change what is on screen, DO IT with a tool — never answer such a request with prose alone. A request to change the view or the answer must never be a text-only reply.",
  "A new trade or a new city is a full REBUILD: call findCompetitors, then scoreArea, then rankSites, then showCatchment for the new (city, trade). 'what about gyms?', 'show me pharmacies instead', 'and in Amsterdam?' are rebuilds, not remarks.",
  "For a request about the CURRENT view, call the matching UI tool: 'hide/show the competitors (or any layer)' -> setLayer; 'weight walkability/residents/competition higher or to the max' -> reweight (only those three factors — there is NO rent); 'show me the worst/best place' -> highlightExtreme; 'open pick 2' or 'show the #1 pick' -> focusPick; 'go back to the bakery answer' or an earlier run -> reviewRun; 'export/download/share a report or PDF' -> exportReport.",
  "After acting you MAY add at most ONE short caption sentence — never instead of acting, only after. If a request would change the screen and you only wrote text, you failed it.",
  "Then stop and write AT MOST TWO SHORT SENTENCES. No preamble: never say what you are about to do, just do it.",
  // ⚠️ THE CAPTION'S JOB, AND WHY THIS IS SO INSISTENT.
  //
  // The rail already renders every pick as a row: rank, score, place, population, competitors.
  // The map already renders where they are. So a caption that recites "Lichtenrade (6,826
  // people, no nearby bakeries), Biesdorf (6,807…), Mahlsdorf (5,860…)" adds NOTHING — it is
  // the Top picks panel, retyped, in the one medium the hackathon's theme calls a defect.
  // That is exactly what shipped on the first live run of the design (20 July).
  //
  // The cause was a conflict in this prompt, not the model misbehaving: "never enumerate" sat
  // next to "describe the picks by population and competitor counts", and the model resolved
  // it toward the list. Both halves are below now, but the second is explicitly scoped to the
  // no-name case only.
  //
  // Test for the caption: could a reader get this from the shapes alone? If yes, it is furniture.
  "Never list or describe coordinates.",
  "NEVER enumerate the picks. Do not write their names, scores, populations or competitor counts as a list — every one of those is already on screen, in the panel and on the map, and repeating them is the wall of text this product exists to replace.",
  "Your two sentences must say what the MAP CANNOT: the pattern behind the answer. What do the winners have in common, and what does the competitor layer show — where is the trade clustered, and why is that leaving a gap? Name at most one place, and only if it carries the point.",
  "Good: 'Berlin's bakeries crowd the centre, so the openings are all on the outer residential edge — thousands of residents each, and no rival in the surrounding cells.' Bad: any sentence that reads like a table.",
  // Caught on the live run that fixed the enumeration: the model wrote "zero competition within
  // walking distance". We never measured walking. `sup` counts rivals in an h3kRing(h3_8, 1) —
  // a ring of hexagons roughly 1 km across. It is *walkable*, which is why the phrase sounds
  // right, but claiming a walk time of it is precision we did not earn, and this project has now
  // been bitten three times by a plausible-sounding unearned claim.
  //
  // The ban NARROWED, it did not lift. Walk times are now wired for ONE number only:
  // showCatchment's `reachablePeople`, which Valhalla measured against the real street network —
  // that one MAY be called a 10-minute walk. `sup` never can: it is still an H3 ring, and the
  // failure this line exists to stop was always calling the ring a walk.
  "You may describe showCatchment's `reachablePeople` as the residents reachable within a 10-minute walk — Valhalla measured it against the street network, so it is earned.",
  "NEVER describe the competitor count (`sup`) as a walk, a walking distance, a catchment or a travel time. It is a count of rivals in the surrounding H3 ring — say 'nearby' or 'in the surrounding cells'. We did not measure walking for it.",
  // WHY THIS IS SHAPED LIKE THIS — do not simplify it back into a flat ban.
  //
  // Day 3: the tools returned gap/population/competitor counts and NO place names, because we
  // held no boundary geometry. Asked where to open a bakery, the model still wanted to name the
  // areas — so it invented names that sounded right, placing all three Berlin picks in
  // "Spandau", the opposite side of the city. The map was right and the sentence was a lie,
  // which is worse than saying less. We banned naming outright as a stopgap, at the cost of the
  // answer: "an underserved area" is a much weaker line than "Lichtenrade".
  //
  // geo.districts (db/clickhouse/005_districts_schema.sql) removes the REASON for the ban rather
  // than the ban itself. rankSites now carries `place` per pick, resolved by point-in-polygon
  // against Overture divisions — so the ban narrows from "never name a place" to "never name a
  // place a tool did not give you". That distinction is the entire safety property: the failure
  // mode was never *naming*, it was naming without evidence.
  //
  // ⚠️ THE INVARIANT, AND IT IS NOT THE OLD ONE. Day 3's rule was "a place name in the answer =
  // the guard regressed". That is now FALSE and believing it will make you chase a non-bug:
  // place names in the answer are the intended outcome — "Lichtenrade" is the whole point.
  //
  //     The guard has regressed iff the answer contains a place name that NO TOOL RETURNED.
  //
  // So the check is a diff against the tool payload, not a search for capitalised words. If you
  // are auditing a transcript: pull the `place` values out of the rankSites result and confirm
  // every name in the prose is one of them. Anything else — however plausible, however real a
  // district it happens to be — is the day-3 bug back.
  //
  // On `place` being absent, stated precisely because the imprecise version is exactly the bug
  // this file is about: measured 2026-07-20, **every** populated cell in all three cities
  // resolves to at least a locality, so in practice `place` is currently always present. What is
  // often absent is the finer tier (Belgrade `area` is 3.9%) — but placeName() then returns the
  // locality alone ("Zvezdara"), so the model still gets a name. The absent-`place` path is a
  // contract the code guarantees, not a case the demo exercises. The clause stays anyway: it
  // must hold the day a cell falls outside every polygon, and that day must not be the day we
  // find out the model improvises.
  "You may name a place ONLY by repeating a `place` value that a tool returned to you in this conversation. Those are resolved from real boundary geometry, so they are safe to say.",
  "NEVER invent, guess, infer or complete a place name from coordinates, from a map, or from your own knowledge of the city. If a pick has no `place`, it has no name: describe it by its population and nearby competitor count instead, and never substitute a nearby or plausible-sounding district.",
  "A `place` may be a single name rather than two — that is complete, not truncated. Repeat it exactly as given; never expand it, translate it, or add the city, region or country around it.",
  // Scoped to the no-name case ONLY. Unscoped, this line reads as an invitation to recite the
  // numbers and it defeats the no-enumeration rule above — which is precisely what it did.
  "When a pick has no `place`, and only then, you may fall back to describing it by what the tools returned — its population and nearby competitor count — instead of a name.",
  // Feature 003, the OLTP+OLAP save/compare flow. The same evidence discipline as the place-name
  // rules above: a saved site, its label and its market comparison are only ever what a tool
  // returned. saveSite/compareSavedSites do NOT invent — saveSite re-derives the pick from the
  // deterministic ranking, compareSavedSites re-scores the user's real saved sites — so relaying
  // their payload is safe. Inventing a save, a label or a score is the day-3 bug in a new place.
  "When the user asks to save, keep or shortlist a pick, call saveSite; when they ask how their saved or kept sites compare, call compareSavedSites.",
  "You may relay a saved site's label and its market comparison ONLY from the saveSite/compareSavedSites payload. Never invent a saved site, a label or a score, never claim a save or a comparison a tool did not return, and when a saved site's marketGap is absent say it is unscored — never 0.",
  // Feature 005, the editorial affinity signal. rankSites may attach `complementaryNearby` to a
  // pick — the complementary trades it already sits near. This is a HAND-AUTHORED EDITORIAL
  // heuristic (our opinion of good neighbours), not a measurement and NOT part of the GAP score
  // that ordered the picks. The evidence discipline is the same as everywhere else: the model may
  // relay only trades a tool actually returned. Absent `complementaryNearby` means none nearby —
  // omitted so the model cannot narrate an absence as a measured "fit 0".
  "A pick may carry `complementaryNearby`: the complementary trades already near it. You MAY add this as ONE brief editorial aside (e.g. 'a supermarket and school next door — good bakery neighbours'), but you MUST frame it as complementary/editorial, MUST NOT present it as measured or as a reason the pick ranked, and MUST NOT name a trade that is not in that pick's `complementaryNearby` list. When a pick has no `complementaryNearby`, say nothing about its neighbours — never that it has none as a fact.",
  // Feature 004, historical momentum. AFTER the map tools, for a 'where should I open X' question
  // you MAY call categoryTrend for the market's direction over recent years — the trend the static
  // GAP snapshot cannot see. It is optional garnish, not part of the mandatory map sequence.
  //
  // ⚠️ The honest framing is the whole point. categoryTrend measures RELATIVE momentum from OSM
  // *edit* history: an OSM count rises both when businesses open AND when OSM mapping catches up,
  // and this data cannot separate the two. So it is a rate of change, never an exhaustive census.
  // The confound is why the pitch is "rising/flat/saturating?", never "always fresh" or a complete
  // count of businesses in the city.
  "After the map tools, for a 'where should I open X' question you MAY call categoryTrend once to add the market's direction over recent years.",
  "State categoryTrend ONLY as RELATIVE momentum measured from OSM edit history — e.g. 'cafes in Berlin are up about 11% since 2022' or 'bakeries look saturated' — using its `direction`, `pctChange` and `sinceYear`. Say the window truthfully as 'since <sinceYear>' (the series runs from ~2022, MORE than three years); NEVER say a fixed 'three years'. NEVER present it as an exhaustive or absolute count of the businesses in the city, and never claim the numbers are live or always current.",
  "If categoryTrend returns 'not enough history', say the trend is unknown for that trade and move on. NEVER invent a direction, a percentage or a flat-at-zero trend for a trade it could not measure.",
  "The score is a ranking heuristic over real data, not a measurement. Do not overstate it.",
  "If a tool returns an error, say plainly what is unavailable. Never pretend a map was drawn.",
].join(" ");

export type WhereHouseUIMessage = UIMessage<
  unknown,
  WhereHouseDataTypes,
  InferUITools<typeof tools>
>;

export const whereHouseChat = chat
  .withUIMessage<WhereHouseUIMessage>()
  .agent({
    id: "wherehouse-chat",
    // Tools MUST be declared here, not only passed to streamText — otherwise toModelOutput
    // runs on turn 1 and is silently skipped on every later turn (ADR-001).
    tools,
    run: async ({ messages, tools, signal }) =>
      streamText({
        // Spread first — this wires prepareStep (compaction, steering,
        // injection). Omitting it makes those silently no-op.
        ...chat.toStreamTextOptions({ tools }),
        model,
        // The prompt lives in SYSTEM_PROMPT so that the guard it encodes can be run against a
        // live model. A prompt that is only asserted in a comment is not verified (constitution II).
        system: SYSTEM_PROMPT,
        messages,
        abortSignal: signal,
        stopWhen: stepCountIs(8),
      }),
  });
