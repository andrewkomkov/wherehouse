/**
 * The layer writer. Every map layer goes through here — no tool calls
 * `chat.response.write` directly.
 *
 * ## Why this exists
 *
 * The Trigger.dev chat stream caps a SINGLE record at ~1 MiB, `data-map` parts included.
 * Crossing it fails the run with `ChatChunkTooLargeError`. It is platform-level and cannot
 * be raised. We already exceed it — measured against the real data, not estimated:
 *
 *   | Berlin bakery dots      |   1,460 pts |  175 KiB | fits          |
 *   | GAP choropleth (res 8)  |   2,260 hex |  549 KiB | fits, no room |
 *   | Berlin food & drink     |  12,746 pts | 1.27 MiB | FAILS         |
 *   | Every Berlin POI        | 139,807 pts | 14.9 MiB | FAILS (14x)   |
 *
 * So a layer over budget never travels on the stream: it lands in `web.layers` and the part
 * carries a handle instead. The browser then reads the GeoJSON straight out of ClickHouse
 * (ADR-003: Cloud serves HTTP, CORS is open, `site` is readonly). The constraint becomes the
 * stunt — on stage the browser talks to ClickHouse directly.
 *
 * Verified end-to-end with the real 549 KiB choropleth: INSERT 770 ms, browser GET 550 ms,
 * byte-identical round trip.
 */

import { chat } from "@trigger.dev/sdk/ai";
import type { ClickHouseClient } from "@clickhouse/client";
// The `Scale` shape (the p95 scalars ClickHouse normalised with, shipped so the browser's sliders
// re-derive the exact score the agent ranked on — see lib/types.ts) is defined once in the
// dependency-free lib/types.ts and re-exported here so existing importers of `@/trigger/layers`
// keep working. It used to be duplicated verbatim between here and components/score.ts.
import type { Scale } from "../lib/types";
export type { Scale };

export type LayerId = "competitors" | "opportunity" | "picks" | "catchment" | "saved";

export type BBox = [number, number, number, number];

export type MapData = {
  layer: LayerId;
  label: string;
  rowCount: number;
  bbox?: BBox;
  scale?: Scale;
  /**
   * A fresh token per emission, so the client can tell one write of a layer from the next even when
   * the row count is identical. The client's paint dedup keyed on `rowCount` for inline layers, so
   * two successive inline writes of the same id with the same count (e.g. `picks` is always 3) were
   * seen as "already painted" and the new geometry never reached the map. `rev` is content-addressed
   * at the emission level — a new write always repaints, a re-render never does. (The handle path was
   * already safe: a new handle is minted per write.)
   */
  rev: string;
  /** Cells in this answer with no measured catchment. Only on the `opportunity` layer.
   *  Measured per city+category (berlin/bakery=830), never a constant. */
  notMeasured?: number;
} & (
  | { kind: "inline"; geojson: unknown }
  | { kind: "handle"; handle: string }
);

/**
 * A 4x margin under the ~1 MiB hard cap, leaving room for the record envelope and for other
 * parts in flight.
 *
 * The measured layers fall cleanly either side of it (175 KiB inline / 549 KiB handle), so
 * this is not a knife-edge. Lowering it is safe; raising it toward 1 MiB is not.
 */
const INLINE_BUDGET_BYTES = 256 * 1024;

/** Unguessable: it is the only thing between a public readonly user and a layer. */
function newHandle(): string {
  return crypto.randomUUID();
}

/**
 * Emit one layer and return what the MODEL is allowed to see.
 *
 * The inline-vs-handle decision is made on the **measured serialized size of this exact
 * payload** — never on a row count. A row-count heuristic is a guess about average feature
 * size, and a category with long names breaks it silently at the worst possible moment.
 * `Buffer.byteLength` is the truth, costs nothing, and cannot be wrong.
 *
 * @param geojsonText the FeatureCollection, already serialized — ClickHouse assembles it in
 *   SQL (26.4 has no `GeoJSON` format), so it arrives as text and is never parsed here.
 *   Parsing it would cost megabytes of heap to learn something we already know.
 */
export async function emitLayer(
  clickhouse: ClickHouseClient,
  opts: {
    layer: LayerId;
    label: string;
    geojsonText: string;
    rowCount: number;
    bbox?: BBox;
    scale?: Scale;
    notMeasured?: number;
  },
): Promise<{ rowCount: number }> {
  const { layer, label, geojsonText, rowCount, bbox, scale, notMeasured } = opts;
  const bytes = Buffer.byteLength(geojsonText, "utf8");
  // One token per emission — the client keys its paint dedup on it (see MapData.rev).
  const rev = crypto.randomUUID();

  if (bytes <= INLINE_BUDGET_BYTES) {
    chat.response.write({
      type: "data-map",
      // The part id IS the layer id. Re-writing the same id updates the part in place
      // rather than appending (ADR-001, proven day 2: parts=1 held across two writes while
      // the content changed). That is what lets each layer fill progressively.
      id: layer,
      data: {
        layer,
        label,
        rowCount,
        rev,
        bbox,
        scale,
        notMeasured,
        kind: "inline",
        geojson: JSON.parse(geojsonText),
      } satisfies MapData,
    });
  } else {
    const handle = newHandle();
    await clickhouse.insert({
      table: "web.layers",
      values: [{ id: handle, body: geojsonText }],
      format: "JSONEachRow",
    });
    chat.response.write({
      type: "data-map",
      id: layer,
      data: { layer, label, rowCount, rev, bbox, scale, notMeasured, kind: "handle", handle } satisfies MapData,
    });
  }

  // ADR-001: the model gets a number. Streaming GeoJSON through the LLM context would be
  // slow, expensive and pointless — it never needs to read the geometry, only know it landed.
  return { rowCount };
}
