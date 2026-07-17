"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  useTriggerChatTransport,
  type InferChatUIMessage,
} from "@trigger.dev/sdk/chat/react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { whereHouseChat } from "@/trigger/chat";
import { mintChatAccessToken, startChatSession } from "@/app/actions";
import { Attribution } from "@/components/attribution";

type Msg = InferChatUIMessage<typeof whereHouseChat>;
type MapPart = Extract<Msg["parts"][number], { type: "data-map" }>;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

// Our own Protomaps tiles out of R2 (infra/basemap.sh). The extract stops at z14,
// so maxzoom must say so or MapLibre asks for tiles that were never cut.
const BASEMAP_TILES = "https://basemap.slim-shaggy.com/berlin/{z}/{x}/{y}.mvt";
const PM_ASSETS = "https://protomaps.github.io/basemaps-assets";

const CH_URL = process.env.NEXT_PUBLIC_CLICKHOUSE_URL!;
const CH_USER = process.env.NEXT_PUBLIC_CLICKHOUSE_SITE_USER!;
const CH_PASS = process.env.NEXT_PUBLIC_CLICKHOUSE_SITE_PASSWORD!;

/**
 * Resolve a layer handle by reading the GeoJSON **straight out of ClickHouse**.
 *
 * No API route, no proxy: ADR-003 proved Cloud serves HTTP with CORS open, and `site` is
 * readonly=1 with SELECT on web.* only. Its password is a public token by design — the same
 * posture as play.clickhouse.com. Measured at 550 ms for the 549 KiB choropleth.
 *
 * Do NOT add `add_http_cors_header=1` — readonly forbids setting overrides and it 500s.
 */
async function fetchLayer(handle: string, signal: AbortSignal): Promise<GeoJSON.FeatureCollection> {
  const params = new URLSearchParams({
    user: CH_USER,
    password: CH_PASS,
    query: `SELECT body FROM web.layers WHERE id='${handle}' FORMAT TabSeparatedRaw`,
  });
  const res = await fetch(`${CH_URL}/?${params}`, { signal });
  if (!res.ok) throw new Error(`layer fetch failed: ${res.status} ${await res.text()}`);
  return JSON.parse(await res.text());
}

const LAYER_IDS = ["opportunity", "competitors", "picks"] as const;

function useMap(container: React.RefObject<HTMLDivElement | null>) {
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      center: [13.404, 52.52],
      zoom: 10,
      style: {
        version: 8,
        glyphs: `${PM_ASSETS}/fonts/{fontstack}/{range}.pbf`,
        sprite: `${PM_ASSETS}/sprites/v4/dark`,
        sources: {
          basemap: {
            type: "vector",
            tiles: [BASEMAP_TILES],
            maxzoom: 14,
            attribution:
              '© <a href="https://openstreetmap.org">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
          },
        },
        layers: layers("basemap", namedFlavor("dark"), { lang: "en" }),
      },
    });

    m.on("load", () => {
      for (const id of LAYER_IDS) {
        m.addSource(id, { type: "geojson", data: EMPTY });
      }

      // Order matters and is fixed here, not by arrival: the surface is the context, the
      // dots sit on it, the answer sits on top. Adding them in arrival order would let a
      // slow choropleth paint over the picks.
      m.addLayer({
        id: "opportunity",
        type: "fill",
        source: "opportunity",
        paint: {
          // 0 = served, 100 = many people and no competitors.
          "fill-color": [
            "interpolate",
            ["linear"],
            ["get", "gap"],
            0, "rgba(0,0,0,0)",
            25, "#2c3d54",
            50, "#3f6d8c",
            75, "#63b0a8",
            100, "#FAFF69",
          ],
          "fill-opacity": 0.55,
        },
      });
      m.addLayer({
        id: "competitors",
        type: "circle",
        source: "competitors",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.5, 14, 4],
          "circle-color": "#ff5c5c",
          "circle-opacity": 0.85,
        },
      });
      m.addLayer({
        id: "picks",
        type: "circle",
        source: "picks",
        paint: {
          "circle-radius": 11,
          "circle-color": "#FAFF69",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#000",
        },
      });
      m.addLayer({
        id: "picks-label",
        type: "symbol",
        source: "picks",
        layout: {
          "text-field": ["to-string", ["get", "rank"]],
          "text-font": ["Noto Sans Medium"],
          "text-size": 13,
        },
        paint: { "text-color": "#000" },
      });

      const popup = new maplibregl.Popup({ closeButton: false });
      // FR-003: a pick must be checkable by hand. The numbers behind the score are on the
      // map, not only in the model's prose.
      m.on("click", "picks", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { rank: number; gap: number; pop: number; sup: number };
        popup
          .setLngLat(e.lngLat)
          .setHTML(
            `<div style="font:12px monospace;color:#000">
               <b>#${p.rank}</b> · score ${p.gap}<br/>
               ${Number(p.pop).toLocaleString("en")} people<br/>
               ${p.sup} competitors within ~1km
             </div>`,
          )
          .addTo(m);
      });
      m.on("mouseenter", "picks", () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", "picks", () => (m.getCanvas().style.cursor = ""));

      map.current = m;
      setReady(true);
    });

    return () => {
      m.remove();
      map.current = null;
    };
  }, [container]);

  return { map, ready };
}

export function Chat() {
  const transport = useTriggerChatTransport<typeof whereHouseChat>({
    task: "wherehouse-chat",
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) => startChatSession({ chatId, clientData }),
  });

  const { messages, sendMessage, status } = useChat<Msg>({ transport });
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const { map, ready } = useMap(container);

  // Latest write wins per layer id — ADR-001 merges parts on type+id, so a layer that is
  // rewritten as it fills arrives here as one part with new content.
  const parts = messages.flatMap((m) =>
    m.parts.filter((p): p is MapPart => p.type === "data-map"),
  );
  const latest = new Map<string, MapPart["data"]>();
  for (const p of parts) latest.set(p.data.layer, p.data);
  const layerStates = [...latest.values()];

  // Key on what actually changes, so a re-render doesn't refetch a 549 KiB layer.
  const signature = layerStates
    .map((d) => `${d.layer}:${d.kind === "handle" ? d.handle : d.rowCount}`)
    .join("|");

  useEffect(() => {
    if (!ready || !map.current) return;
    const ac = new AbortController();
    const m = map.current;

    (async () => {
      for (const data of latest.values()) {
        const src = m.getSource(data.layer) as maplibregl.GeoJSONSource | undefined;
        if (!src) continue;
        try {
          const gj =
            data.kind === "inline"
              ? (data.geojson as GeoJSON.FeatureCollection)
              : await fetchLayer(data.handle, ac.signal);
          if (ac.signal.aborted) return;
          src.setData(gj);
          if (data.bbox) {
            const [w, s, e, n] = data.bbox;
            m.fitBounds([w, s, e, n], { padding: 60, duration: 900, maxZoom: 13 });
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") return;
          setError(`${data.layer}: ${(err as Error).message}`);
        }
      }
    })();

    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, signature, map]);

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "monospace" }}>
      <div style={{ width: 380, padding: 16, overflow: "auto", background: "#111", color: "#eee" }}>
        <h1 style={{ fontSize: 15, marginTop: 0 }}>WhereHouse</h1>

        {messages.map((m) => (
          <div key={m.id} style={{ marginBottom: 10, fontSize: 13 }}>
            <b style={{ color: m.role === "user" ? "#FAFF69" : "#63b0a8" }}>{m.role}:</b>{" "}
            {m.parts.map((p, i) =>
              p.type === "text" ? <span key={i}>{p.text}</span> : null,
            )}
          </div>
        ))}

        {layerStates.length > 0 && (
          <div style={{ fontSize: 11, opacity: 0.65, margin: "12px 0" }}>
            {layerStates.map((d) => (
              <div key={d.layer}>
                {d.label} · {d.rowCount.toLocaleString("en")}
                {/* Worth surfacing: this is the 1 MiB mitigation doing its job on stage. */}
                {d.kind === "handle" ? " · streamed from ClickHouse" : ""}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div style={{ color: "#ff5c5c", fontSize: 12, margin: "8px 0" }}>{error}</div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim()) return;
            setError(null);
            sendMessage({ text: input });
            setInput("");
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="where should I open a bakery in Berlin?"
            style={{ width: "100%", padding: 6, background: "#222", color: "#eee", border: "1px solid #444" }}
          />
          <button
            type="submit"
            disabled={status === "streaming"}
            style={{ marginTop: 6, padding: "4px 10px" }}
          >
            {status === "streaming" ? "…" : "ask"}
          </button>
        </form>
      </div>

      <div style={{ flex: 1, position: "relative" }}>
        <div ref={container} style={{ position: "absolute", inset: 0 }} />
        <Attribution />
      </div>
    </div>
  );
}
