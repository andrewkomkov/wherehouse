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

type Msg = InferChatUIMessage<typeof whereHouseChat>;

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

// Our own Protomaps tiles out of R2 (infra/basemap.sh). The extract stops at z14,
// so maxzoom must say so or MapLibre asks for tiles that were never cut.
const BASEMAP_TILES = "https://basemap.slim-shaggy.com/berlin/{z}/{x}/{y}.mvt";
const PM_ASSETS = "https://protomaps.github.io/basemaps-assets";

function useMap(container: React.RefObject<HTMLDivElement | null>) {
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      center: [13.404, 52.52],
      zoom: 11,
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
      m.addSource("sites", { type: "geojson", data: EMPTY_GEOJSON });
      m.addLayer({
        id: "sites",
        type: "circle",
        source: "sites",
        paint: {
          "circle-radius": 10,
          "circle-color": "#FAFF69",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#000",
        },
      });
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
    startSession: ({ chatId, clientData }) =>
      startChatSession({ chatId, clientData }),
  });

  const { messages, sendMessage, status } = useChat<Msg>({ transport });
  const [input, setInput] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const { map, ready } = useMap(container);

  // Every data-map part currently on the wire. THE GATE: after a turn that wrote
  // the same id twice, this must hold ONE part whose geometry changed — not two.
  const mapParts = messages.flatMap((m) =>
    m.parts.filter(
      (p): p is Extract<Msg["parts"][number], { type: "data-map" }> =>
        p.type === "data-map",
    ),
  );
  const last = mapParts.at(-1);

  useEffect(() => {
    if (!ready || !map.current || !last) return;
    const src = map.current.getSource("sites") as maplibregl.GeoJSONSource;
    src?.setData(last.data.geojson as GeoJSON.FeatureCollection);
  }, [ready, last, map]);

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "monospace" }}>
      <div style={{ width: 420, padding: 16, overflow: "auto" }}>
        <h1 style={{ fontSize: 16 }}>WhereHouse — walking skeleton</h1>

        <div
          style={{
            border: "2px solid #FAFF69",
            padding: 8,
            margin: "12px 0",
            fontSize: 13,
          }}
        >
          <div>
            <b>ADR-001 gate</b>
          </div>
          <div>
            data-map parts: <b style={{ fontSize: 18 }}>{mapParts.length}</b>
          </div>
          <div>showing: {last?.data.label ?? "—"}</div>
          <div style={{ marginTop: 6, opacity: 0.7 }}>
            The tool writes id=&quot;map&quot; once per saved site. 1 part = merges
            in place (ADR-001 holds). 2+ parts = appends (ADR-001 is wrong).
          </div>
        </div>

        {messages.map((m) => (
          <div key={m.id} style={{ marginBottom: 8, fontSize: 13 }}>
            <b>{m.role}:</b>{" "}
            {m.parts.map((p, i) =>
              p.type === "text" ? <span key={i}>{p.text}</span> : null,
            )}
          </div>
        ))}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim()) return;
            sendMessage({ text: input });
            setInput("");
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="show me my saved sites"
            style={{ width: "100%", padding: 6 }}
          />
          <button type="submit" disabled={status === "streaming"}>
            {status === "streaming" ? "…" : "send"}
          </button>
        </form>
      </div>

      <div ref={container} style={{ flex: 1 }} />
    </div>
  );
}
