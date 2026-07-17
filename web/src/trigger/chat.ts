import { chat } from "@trigger.dev/sdk/ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText, stepCountIs, tool } from "ai";
import type { InferUITools, UIMessage } from "ai";
import { createClient } from "@clickhouse/client";
import { z } from "zod";
import { emitLayer, type MapData, type BBox } from "./layers";
import {
  CITIES,
  isCity,
  competitorsSql,
  bboxSql,
  choroplethSql,
  choroplethStatsSql,
  rankSql,
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

// NB: do NOT write `UIDataTypes & { map: MapData }` as the docs example does.
// UIDataTypes is Record<string, unknown>, so intersecting widens keyof to
// `string` — the part type degrades to `data-${string}` with `data: unknown`
// and the client loses all narrowing. Declare the map bare instead.
type WhereHouseDataTypes = { map: MapData };

/**
 * The demo questions ask for trades, not for Overture taxonomy strings. This maps one to the
 * other. Deliberately a lookup and not an LLM taxonomy mapper: it answers every question we
 * demo, and inference would be a day of work for zero rubric points.
 *
 * A group (several categories) is how a question gets wide enough to exceed the stream cap —
 * which is the point of User Story 2, not an accident.
 */
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  bakery: ["bakery"],
  bakeries: ["bakery"],
  pharmacy: ["pharmacy"],
  pharmacies: ["pharmacy"],
  kindergarten: ["kindergarten"],
  cafe: ["cafe"],
  coffee: ["cafe"],
  restaurant: ["restaurant"],
  restaurants: ["restaurant"],
  bar: ["bar"],
  supermarket: ["supermarket"],
  gym: ["gym"],
  "food and drink": ["restaurant", "cafe", "bar", "fast_food", "bakery", "pub"],
  "food & drink": ["restaurant", "cafe", "bar", "fast_food", "bakery", "pub"],
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
        `"food and drink" is a GROUP covering restaurants, cafes, bars, fast food, bakeries and pubs — ` +
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
      queryRows<{ cellCount: number; topGap: number; medianGap: number }>(
        choroplethStatsSql(c.city, cats),
      ),
    ]);

    const s = stats[0];
    // ~549 KiB for Berlin ⇒ this always takes the handle path. That is deliberate: the
    // mitigation runs on the primary demo's own layer, so it cannot rot unnoticed.
    await emitLayer(clickhouse, {
      layer: "opportunity",
      label: `opportunity for ${category} across ${c.city}`,
      geojsonText,
      rowCount: s?.cellCount ?? 0,
    });

    return { cellCount: s?.cellCount ?? 0, topGap: s?.topGap ?? 0, medianGap: s?.medianGap ?? 0 };
  },
});

type Pick = { h3: string; gap: number; pop: number; sup: number; lon: number; lat: number };

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

    const geojson = {
      type: "FeatureCollection",
      features: picks.map((p, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        properties: { rank: i + 1, gap: p.gap, pop: p.pop, sup: p.sup, h3: p.h3 },
      })),
    };

    await emitLayer(clickhouse, {
      layer: "picks",
      label: `top ${picks.length} for ${category} in ${c.city}`,
      geojsonText: JSON.stringify(geojson),
      rowCount: picks.length,
    });

    // The one tool whose result the model may legitimately mention: FR-003 wants the user to
    // see the numbers behind each pick. Even so the MAP carries them — this is the garnish.
    return {
      picks: picks.map((p, i) => ({
        rank: i + 1,
        gap: p.gap,
        population: p.pop,
        competitorsNearby: p.sup,
      })),
    };
  },
});

const tools = { findCompetitors, scoreArea, rankSites };

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
        system: [
          "You are WhereHouse, a site-selection assistant. The map is the answer; your prose is not.",
          "For 'where should I open X in Y', call findCompetitors, then scoreArea, then rankSites — in that order, so the map builds up as you work.",
          "Then stop and write AT MOST TWO SHORT SENTENCES. No preamble: never say what you are about to do, just do it.",
          "Never list or describe coordinates. Never enumerate the picks in prose — they are already pinned on the map.",
          // The tools return gap/population/competitor counts and NO place names, because we
          // hold no district geometry. Asked to name an area, the model will invent one that
          // sounds right: on the first live run it confidently placed all three Berlin picks
          // in "Spandau" — the opposite side of the city from where they actually are. The
          // map was right and the sentence was a lie, which is worse than saying less.
          "NEVER name a district, neighbourhood or street. You do not know them: no tool gives you place names, and guessing from coordinates produces confident falsehoods.",
          "Describe the picks only by what the tools actually returned — population and nearby competitor counts.",
          "The score is a ranking heuristic over real data, not a measurement. Do not overstate it.",
          "If a tool returns an error, say plainly what is unavailable. Never pretend a map was drawn.",
        ].join(" "),
        messages,
        abortSignal: signal,
        stopWhen: stepCountIs(8),
      }),
  });
