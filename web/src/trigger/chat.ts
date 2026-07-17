import { chat } from "@trigger.dev/sdk/ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText, stepCountIs, tool } from "ai";
import type { InferUITools, UIMessage } from "ai";
import { createClient } from "@clickhouse/client";
import { z } from "zod";

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

/** A GeoJSON FeatureCollection of points, plus a caption for the layer. */
type MapData = {
  label: string;
  geojson: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      geometry: { type: "Point"; coordinates: [number, number] };
      properties: Record<string, unknown>;
    }>;
  };
};

// NB: do NOT write `UIDataTypes & { map: MapData }` as the docs example does.
// UIDataTypes is Record<string, unknown>, so intersecting widens keyof to
// `string` — the part type degrades to `data-${string}` with `data: unknown`
// and the client loses all narrowing. Declare the map bare instead.
type WhereHouseDataTypes = { map: MapData };

/**
 * Every map write reuses this id. ADR-001 rests on the claim that re-writing the
 * same `type` + `id` updates the part in place rather than appending — which is
 * what turns the map into a surface the agent fills in progressively.
 */
const MAP_PART_ID = "map";

type SiteRow = { label: string; lon: number; lat: number; score: number };

function toMapData(label: string, rows: SiteRow[]): MapData {
  return {
    label,
    geojson: {
      type: "FeatureCollection",
      features: rows.map((r) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.lon, r.lat] },
        properties: { label: r.label, score: r.score },
      })),
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const showSavedSites = tool({
  description:
    "Show the user's saved candidate sites on the map. Call this whenever the user asks where their sites are, or asks to see anything on a map.",
  inputSchema: z.object({}),
  execute: async () => {
    const rs = await clickhouse.query({
      query: `
        SELECT label, lon, lat, score
        FROM oltp.pg_saved_sites
        WHERE _peerdb_is_deleted = 0
        ORDER BY id
      `,
      format: "JSONEachRow",
    });
    const rows = (await rs.json()) as SiteRow[];

    // --- The ADR-001 gate, run for real on every call. ---
    // Two writes, one id. If parts merge by id the single dot travels from the
    // first site to the second; if they append, two parts show up instead.
    // Both rows are real ClickHouse rows ~4km apart in Berlin, so the difference
    // is impossible to misread.
    for (const [i, row] of rows.entries()) {
      chat.response.write({
        type: "data-map",
        id: MAP_PART_ID,
        data: toMapData(`site ${i + 1}/${rows.length}: ${row.label}`, [row]),
      });
      await sleep(1500);
    }

    // ADR-001: the model never sees the geometry — only a count. The GeoJSON
    // reached the UI out-of-band, above.
    return { rowCount: rows.length };
  },
});

const tools = { showSavedSites };

export type WhereHouseUIMessage = UIMessage<
  unknown,
  WhereHouseDataTypes,
  InferUITools<typeof tools>
>;

export const whereHouseChat = chat
  .withUIMessage<WhereHouseUIMessage>()
  .agent({
    id: "wherehouse-chat",
    tools,
    run: async ({ messages, tools, signal }) =>
      streamText({
        // Spread first — this wires prepareStep (compaction, steering,
        // injection). Omitting it makes those silently no-op.
        ...chat.toStreamTextOptions({ tools }),
        model,
        system:
          "You are WhereHouse, a site-selection assistant. The map is the answer, not your prose. " +
          "Call showSavedSites to put results on the map, then add at most one short sentence. Never describe coordinates in text.",
        messages,
        abortSignal: signal,
        stopWhen: stepCountIs(5),
      }),
  });
