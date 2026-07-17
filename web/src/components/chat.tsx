"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  useTriggerChatTransport,
  type InferChatUIMessage,
} from "@trigger.dev/sdk/chat/react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { whereHouseChat } from "@/trigger/chat";
import type { LayerId, Scale } from "@/trigger/layers";
import { mintChatAccessToken, startChatSession } from "@/app/actions";
import { Attribution } from "@/components/attribution";
import {
  FACTORS,
  NEUTRAL,
  fillColor,
  gapDisplay,
  isNeutral,
  type CellProps,
  type Weights,
} from "@/components/score";

type Msg = InferChatUIMessage<typeof whereHouseChat>;
type MapPart = Extract<Msg["parts"][number], { type: "data-map" }>;
type LayerData = MapPart["data"];

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

// Our own Protomaps tiles out of R2 (infra/basemap.sh). The extract stops at z14, so maxzoom
// must say so or MapLibre asks for tiles that were never cut. Deliberately not a CDN basemap:
// serving our own tiles is part of what we are demonstrating.
const BASEMAP_TILES = "https://basemap.slim-shaggy.com/berlin/{z}/{x}/{y}.mvt";
const PM_ASSETS = "https://protomaps.github.io/basemaps-assets";

const CH_URL = process.env.NEXT_PUBLIC_CLICKHOUSE_URL!;
const CH_USER = process.env.NEXT_PUBLIC_CLICKHOUSE_SITE_USER!;
const CH_PASS = process.env.NEXT_PUBLIC_CLICKHOUSE_SITE_PASSWORD!;

/**
 * The palette. Every value here is load-bearing; see the design brief's "Colour: the sponsors,
 * and the trap".
 */
const C = {
  bg: "#0a0c0f",
  text: "#e7ecf0",
  /** The one accent. Chrome only — never a data value. */
  accent: "#6ff0e0",
  /**
   * ClickHouse `primary.300`. **Spent in exactly one place: the #1 pick.**
   *
   * Not on buttons, not on borders, not at the top of the choropleth ramp. It is both a nod to
   * one sponsor and the single most important pixel on the screen, and it only reads as either
   * if it appears once. (The previous build used it as the ramp's 100 stop AND the pick fill —
   * which made the winning pin invisible against the cells it had won.)
   */
  win: "#FAFF69",
  /** Competitors. Warm, so it separates from the cool choropleth underneath it. */
  competitor: "#ff6b57",
  dim: "#5c6771",
  faint: "#4c5560",
  panel: "rgba(11,13,16,.8)",
  hair: "rgba(255,255,255,.08)",
} as const;

const MONO = "'IBM Plex Mono', ui-monospace, monospace";
const SANS = "'IBM Plex Sans', system-ui, sans-serif";

/**
 * The waves, in the order the agent actually produces them.
 *
 * This is ADR-001's choreography made visible, and it is the one piece of chrome that earns its
 * pixels: it shows a judge that the map is *computed*, wave by wave, and where each wave came
 * from. `source` is not decoration — "ClickHouse" on a row that is genuinely a ClickHouse query
 * is 25% of the rubric, stated by the UI instead of by us talking over the demo.
 *
 * ⚠️ Each row's state is derived from REAL stream events (a tool part running, a `data-map` part
 * landing) — never from a timer. A row cannot show ● unless the layer is on the map. If you are
 * tempted to advance these on a schedule so the demo looks smooth, don't: a progress indicator
 * that runs ahead of the work is the "loading skeleton that pretends" the brief bans.
 *
 * The comp has a 7th wave, "Walk catchment · Valhalla", between competitors and the surface.
 * **It is deliberately absent**: the isochrones are still being computed by another workstream,
 * and a row that never leaves ○ is worse than a row that isn't there. Adding it is one entry
 * here plus one `LAYER` case — nothing else in this file assumes there are exactly four.
 */
const WAVES = [
  { key: "read", label: "Read the question", source: "agent" },
  { key: "competitors", label: "Competitor dots", source: "ClickHouse", tool: "tool-findCompetitors", layer: "competitors" },
  { key: "opportunity", label: "Opportunity surface", source: "ClickHouse", tool: "tool-scoreArea", layer: "opportunity" },
  { key: "picks", label: "Rank top 3", source: "agent", tool: "tool-rankSites", layer: "picks" },
  { key: "caption", label: "Caption", source: "agent" },
] as const;

type WaveState = "pending" | "active" | "done";

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

const LAYER_IDS: LayerId[] = ["opportunity", "competitors", "picks"];

// ---------------------------------------------------------------------------------------------
// Animation
//
// The brief's rule: **every animation must represent something real happening.** A layer reveals
// because its data just arrived from ClickHouse; a hex is coloured because the score actually
// says so. Nothing below animates to look busy, and the one place motion is banned — the slider
// recolour — has no transition at all (see `fill-color` and `recolour`).
// ---------------------------------------------------------------------------------------------

/** A cancellable rAF tween. Resolves early (without a final frame) if cancelled. */
function tween(ms: number, onFrame: (t: number) => void, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = () => {
      if (cancelled()) return resolve();
      const t = Math.min(1, (performance.now() - t0) / ms);
      onFrame(t);
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Give every feature a reveal order.
 *
 * `idx`/`dist` are **presentation**, not data — they decide the order pixels appear in, and
 * ClickHouse returns rows in whatever order it likes. Ordering outward from the centre reads as
 * a wave crossing the city; arrival order reads as noise. This is the one place we are allowed
 * to invent a number, because it says nothing about the world.
 */
function withRevealOrder(fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  const pos = (f: GeoJSON.Feature): [number, number] => {
    const g = f.geometry;
    if (g.type === "Point") return g.coordinates as [number, number];
    if (g.type === "Polygon") return g.coordinates[0][0] as [number, number];
    return [0, 0];
  };
  const pts = fc.features.map(pos);
  if (!pts.length) return fc;
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  // Degrees are fine: this is a sort key, not a distance anyone reads.
  const d = pts.map(([x, y]) => Math.hypot((x - cx) * Math.cos((cy * Math.PI) / 180), y - cy));
  const max = Math.max(...d) || 1;

  const order = fc.features.map((_, i) => i).sort((a, b) => d[a] - d[b]);
  const rank = new Array<number>(fc.features.length);
  order.forEach((featureIdx, r) => (rank[featureIdx] = r));

  fc.features.forEach((f, i) => {
    f.properties = { ...f.properties, idx: rank[i], dist: d[i] / max };
  });
  return fc;
}

// ---------------------------------------------------------------------------------------------

function useMapInstance(container: React.RefObject<HTMLDivElement | null>) {
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      center: [13.404, 52.52],
      zoom: 9.7,
      attributionControl: false,
      dragRotate: false,
      style: {
        version: 8,
        glyphs: `${PM_ASSETS}/fonts/{fontstack}/{range}.pbf`,
        sprite: `${PM_ASSETS}/sprites/v4/dark`,
        sources: {
          basemap: {
            type: "vector",
            tiles: [BASEMAP_TILES],
            maxzoom: 14,
          },
        },
        layers: layers("basemap", namedFlavor("dark"), { lang: "en" }),
      },
    });

    m.on("load", () => {
      for (const id of LAYER_IDS) m.addSource(id, { type: "geojson", data: EMPTY });

      // Order matters and is fixed here, not by arrival: the surface is the context, the dots
      // sit on it, the answer sits on top. Adding them in arrival order would let a slow
      // choropleth paint over the competitors.
      m.addLayer({
        id: "opportunity",
        type: "fill",
        source: "opportunity",
        // Starts invisible and stays invisible until the reveal runs — otherwise the layer
        // pops in whole, which reads as "an image loaded" rather than "this was computed".
        paint: { "fill-color": "rgba(0,0,0,0)", "fill-opacity": 0 },
      });
      m.addLayer({
        id: "opportunity-line",
        type: "line",
        source: "opportunity",
        paint: {
          "line-color": "rgba(140,220,225,0.14)",
          "line-width": 0.5,
          "line-opacity": 0,
        },
      });
      m.addLayer({
        id: "competitors",
        type: "circle",
        source: "competitors",
        paint: {
          "circle-radius": 0,
          "circle-color": C.competitor,
          "circle-opacity": 0,
          "circle-stroke-width": 0.5,
          "circle-stroke-color": "rgba(0,0,0,0.35)",
        },
      });
      // `picks` has no MapLibre layer — the three pins are DOM markers (see PickMarkers). A
      // circle layer cannot do the #1's glow, its pulse ring, or the drop-and-settle, and there
      // are only ever three of them.

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

// ---------------------------------------------------------------------------------------------

export function Chat() {
  const transport = useTriggerChatTransport<typeof whereHouseChat>({
    task: "wherehouse-chat",
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) => startChatSession({ chatId, clientData }),
  });

  const { messages, sendMessage, status } = useChat<Msg>({ transport });
  const [input, setInput] = useState("where should I open a bakery in Berlin?");
  const [error, setError] = useState<string | null>(null);
  const [weights, setWeights] = useState<Weights>({ ...NEUTRAL });
  const [visible, setVisible] = useState<Record<LayerId, boolean>>({
    opportunity: true,
    competitors: true,
    picks: true,
  });
  const [selected, setSelected] = useState<number | null>(null);
  const [replaying, setReplaying] = useState(false);
  /**
   * Bumped whenever `store` (a ref) gains a layer, purely to force a re-render.
   *
   * It exists because a ref mutation is invisible to React, and the pick list and the Replay
   * button both read `store.current`. It is deliberately NOT `replaying`: reusing that as a
   * re-render nudge latched it to `true` the moment picks landed, which disabled Replay
   * permanently and made `replay()` early-return — a button that silently never worked.
   */
  const [storeVersion, bumpStore] = useReducer((n: number) => n + 1, 0);

  const container = useRef<HTMLDivElement>(null);
  const { map, ready } = useMapInstance(container);

  /** The resolved GeoJSON per layer, kept so Replay never needs the agent again. */
  const store = useRef<Partial<Record<LayerId, GeoJSON.FeatureCollection>>>({});
  /** Signature of what is already painted, so a later layer landing does not refetch earlier ones. */
  const painted = useRef(new Map<LayerId, string>());
  /** Bumped to cancel in-flight tweens when a new answer or a replay starts. */
  const gen = useRef(0);

  // Latest write wins per layer id — ADR-001 merges parts on type+id, so a layer that is
  // rewritten as it fills arrives here as one part with new content.
  const latest = useMemo(() => {
    const out = new Map<LayerId, LayerData>();
    for (const m of messages)
      for (const p of m.parts) if (p.type === "data-map") out.set(p.data.layer, p.data);
    return out;
  }, [messages]);

  const signature = [...latest.values()]
    .map((d) => `${d.layer}:${d.kind === "handle" ? d.handle : d.rowCount}`)
    .join("|");

  /** The p95 scalars this answer was scored with. Only the opportunity layer carries them. */
  const scale: Scale | undefined = latest.get("opportunity")?.scale;

  const picks = useMemo(() => {
    const fc = store.current.picks;
    void storeVersion; // recompute when a new picks layer lands in the store ref
    return (fc?.features ?? []) as GeoJSON.Feature<GeoJSON.Point, PickProps>[];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, storeVersion]);

  // ---- painting -------------------------------------------------------------------------

  const paint = useCallback(
    async (m: maplibregl.Map, layer: LayerId, fc: GeoJSON.FeatureCollection, myGen: number) => {
      const cancelled = () => gen.current !== myGen;
      const src = m.getSource(layer) as maplibregl.GeoJSONSource | undefined;
      if (!src && layer !== "picks") return;

      if (layer === "competitors") {
        src!.setData(fc);
        const n = fc.features.length;
        const on = visible.competitors ? 0.82 : 0;
        // Stagger by index. The dots genuinely arrive together — but they were *counted* one by
        // one, and a 1,460-dot layer that appears in a single frame reads as a picture. Capped
        // at 720ms so a wide category cannot turn this into a minute of theatre.
        await tween(
          720,
          (t) => {
            const shown = t * n;
            m.setPaintProperty("competitors", "circle-radius", [
              "interpolate", ["linear"], ["-", shown, ["get", "idx"]], 0, 0, 9, 3.1,
            ]);
            m.setPaintProperty("competitors", "circle-opacity", [
              "case", ["<=", ["get", "idx"], shown], on, 0,
            ]);
          },
          cancelled,
        );
        if (cancelled()) return;
        m.setPaintProperty("competitors", "circle-radius", [
          "interpolate", ["linear"], ["zoom"], 9, 2.2, 14, 4.5,
        ]);
        m.setPaintProperty("competitors", "circle-opacity", on);
        return;
      }

      if (layer === "opportunity") {
        src!.setData(fc);
        const base = visible.opportunity ? 0.72 : 0;
        m.setPaintProperty("opportunity-line", "line-opacity", visible.opportunity ? 1 : 0);
        // Per-hex reveal, outward from the centre. The brief is explicit that a block fade reads
        // as "image loaded" and individual cells read as "computed" — and here that is literally
        // true: each hex is one row ClickHouse scored.
        await tween(
          680,
          (t) => {
            const front = t * 1.1;
            m.setPaintProperty("opportunity", "fill-opacity", [
              "interpolate", ["linear"], ["get", "dist"], Math.max(0, front - 0.08), base, front, 0,
            ]);
          },
          cancelled,
        );
        if (cancelled()) return;
        m.setPaintProperty("opportunity", "fill-opacity", base);
        return;
      }
    },
    [visible],
  );

  /** Recolour. No tween, no `-transition`: the immediacy IS the feature (brief, row 8). */
  const recolour = useCallback(
    (m: maplibregl.Map) => {
      if (!m.getLayer("opportunity")) return;
      const o = latest.get("opportunity");
      if (!o) return;
      m.setPaintProperty(
        "opportunity",
        "fill-color",
        // No `scale` ⇒ we cannot re-derive the score, so we show ClickHouse's own `gap` verbatim
        // and the sliders are disabled. Showing a guessed re-derivation would be worse than
        // showing no control.
        scale
          ? fillColor(scale, weights)
          : ([
              "interpolate", ["linear"], ["get", "gap"],
              0, "rgba(20,32,48,0)", 15, "rgba(22,46,68,0.4)", 40, "#1c5a7a",
              65, "#2b9fae", 85, "#57d8cf", 100, "#8ff2dd",
            ] as maplibregl.ExpressionSpecification),
      );
    },
    [latest, scale, weights],
  );

  // Fetch + paint each layer exactly once, as it lands.
  useEffect(() => {
    if (!ready || !map.current) return;
    const ac = new AbortController();
    const m = map.current;

    (async () => {
      for (const data of latest.values()) {
        const sig = `${data.kind === "handle" ? data.handle : data.rowCount}`;
        if (painted.current.get(data.layer) === sig) continue;
        try {
          const raw =
            data.kind === "inline"
              ? (data.geojson as GeoJSON.FeatureCollection)
              : await fetchLayer(data.handle, ac.signal);
          if (ac.signal.aborted) return;
          const fc = withRevealOrder(raw);
          store.current[data.layer] = fc;
          painted.current.set(data.layer, sig);

          if (data.bbox) {
            const [w, s, e, n] = data.bbox;
            // Wave 1 in the comp is "fly to the city". Ours flies when the competitor bbox
            // lands, because that is when we first know where the city is — the agent resolved
            // it, we did not hardcode it.
            m.fitBounds([w, s, e, n], { padding: { top: 60, right: 60, bottom: 60, left: 380 }, duration: 900, maxZoom: 13 });
          }
          if (data.layer === "opportunity") recolour(m);
          await paint(m, data.layer, fc, gen.current);
          // Re-render so the pick list and the Replay button can see the new store contents.
          bumpStore();
        } catch (err) {
          if ((err as Error).name === "AbortError") return;
          setError(`${data.layer}: ${(err as Error).message}`);
        }
      }
    })();

    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, signature, map]);

  // Slider moves recolour; nothing is refetched and no data is re-sent.
  useEffect(() => {
    if (ready && map.current) recolour(map.current);
  }, [ready, map, recolour]);

  // Layer toggles. ~150ms of utility, not spectacle.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !m.getLayer("opportunity")) return;
    m.setPaintProperty("opportunity", "fill-opacity", visible.opportunity ? 0.72 : 0);
    m.setPaintProperty("opportunity-line", "line-opacity", visible.opportunity ? 1 : 0);
    m.setPaintProperty("competitors", "circle-opacity", visible.competitors ? 0.82 : 0);
  }, [ready, map, visible]);

  /**
   * Replay the assembly from data we already hold.
   *
   * It **must not** re-run the agent: every run costs real money against a $4.87 LLM budget, and
   * a judge will press this button more than once. Nothing here talks to Trigger.dev or the
   * model — the GeoJSON is in `store`, and what replays is the client-side choreography.
   */
  const replay = useCallback(async () => {
    const m = map.current;
    if (!m || replaying) return;
    const myGen = ++gen.current;
    setReplaying(true);
    setSelected(null);

    m.setPaintProperty("opportunity", "fill-opacity", 0);
    m.setPaintProperty("opportunity-line", "line-opacity", 0);
    m.setPaintProperty("competitors", "circle-opacity", 0);
    m.setPaintProperty("competitors", "circle-radius", 0);
    await sleep(120);

    for (const w of WAVES) {
      if (gen.current !== myGen) break;
      if (!("layer" in w)) continue;
      const fc = store.current[w.layer as LayerId];
      if (!fc) continue;
      await paint(m, w.layer as LayerId, fc, myGen);
      await sleep(150);
    }
    if (gen.current === myGen) setReplaying(false);
  }, [map, paint, replaying]);

  // ---- derived UI state -----------------------------------------------------------------

  const last = messages.filter((m) => m.role === "assistant").at(-1);
  const caption = (last?.parts ?? [])
    .filter((p): p is Extract<Msg["parts"][number], { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

  const toolStates = useMemo(() => {
    const out = new Map<string, string>();
    for (const m of messages)
      for (const p of m.parts as unknown as { type: string; state?: string }[])
        if (p.type.startsWith("tool-")) out.set(p.type, p.state ?? "");
    return out;
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";

  const waveState = (w: (typeof WAVES)[number]): WaveState => {
    if (w.key === "read") {
      if (toolStates.size > 0 || latest.size > 0) return "done";
      return status === "submitted" ? "active" : "pending";
    }
    if (w.key === "caption") {
      if (!busy && caption.length > 0) return "done";
      if (latest.has("picks") && caption.length > 0) return "active";
      return "pending";
    }
    // A layer wave is ● only when its layer is genuinely on the map, and ◐ only while its tool
    // is genuinely executing. Neither is a timer.
    if (latest.has(w.layer as LayerId)) return "done";
    const st = toolStates.get(w.tool as string);
    return st !== undefined && st !== "output-available" && st !== "output-error"
      ? "active"
      : "pending";
  };

  const activeWave = WAVES.find((w) => waveState(w) === "active");
  const statusText = activeWave
    ? activeWave.key === "read"
      ? "reading the question"
      : `${activeWave.source === "ClickHouse" ? "querying ClickHouse" : "agent"} · ${activeWave.label.toLowerCase()}`
    : null;

  const neutral = isNeutral(weights);

  return (
    <div
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: C.bg,
        fontFamily: SANS,
        color: C.text,
      }}
    >
      <style>{CSS}</style>
      <div ref={container} style={{ position: "absolute", inset: 0 }} />

      <PickMarkers
        map={map}
        ready={ready}
        picks={picks}
        visible={visible.picks}
        onSelect={setSelected}
      />

      {/* Transient status. The only indeterminate indicator in the product, and it disappears
          the moment there is something real to look at. */}
      {statusText && (
        <div className="wh-pill">
          <span className="wh-dot" />
          <span>{statusText}</span>
        </div>
      )}

      <div className="wh-rail">
        <header style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 5,
              background: C.win,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ width: 9, height: 9, borderRadius: "50%", border: `2px solid ${C.bg}` }} />
          </div>
          <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-.01em" }}>WhereHouse</div>
          <div
            style={{
              marginLeft: "auto",
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: ".1em",
              color: C.dim,
              textTransform: "uppercase",
            }}
          >
            site selection
          </div>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim() || busy) return;
            setError(null);
            setSelected(null);
            store.current = {};
            painted.current.clear();
            gen.current++;
            sendMessage({ text: input });
          }}
          style={{ position: "relative", margin: 0 }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="where should I open a bakery in Berlin?"
            className="wh-ask"
          />
          <button type="submit" aria-label="ask" disabled={busy} className="wh-go">
            →
          </button>
        </form>

        {caption && (
          <div
            style={{
              padding: "12px 13px",
              borderRadius: 10,
              background: "rgba(111,240,224,.06)",
              border: "1px solid rgba(111,240,224,.18)",
            }}
          >
            {/*
             * Whatever the model streamed — never a sentence written here.
             *
             * The comp hardcodes "…almost no competitor within a 15-minute walk". We have no
             * 15-minute walk: supply is an H3 k=1 ring. Putting the comp's sentence in the
             * client would make the UI assert something the data cannot support, and the model
             * is separately forbidden from inventing (SYSTEM_PROMPT in trigger/chat.ts). The
             * caption is the agent's claim, and it is the agent's to defend.
             *
             * The caret is real: it blinks only while tokens are still arriving. No typewriter —
             * the text genuinely streams, so faking the typing would be animating over the one
             * moment that needs no help.
             */}
            <div style={{ fontSize: 13.5, lineHeight: 1.5, color: "#eaf1f2", textWrap: "pretty" }}>
              {caption}
              {busy && <span className="wh-caret">▋</span>}
            </div>
            <div style={{ marginTop: 9, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {/*
               * The comp's chips are CATCHMENT · MEASURED and DEMAND · EST. 2023.
               *
               * CATCHMENT · MEASURED is **cut**: it would be true only with a Valhalla isochrone
               * on screen, and there is none. Supply is measured — it is a count of real Overture
               * POIs — so the measured/estimated contrast the chips exist for survives intact,
               * making a claim we can actually defend.
               */}
              <Chip tone="accent">SUPPLY · MEASURED</Chip>
              <Chip>DEMAND · EST. 2023</Chip>
            </div>
          </div>
        )}

        {error && (
          <div style={{ color: C.competitor, fontSize: 12, fontFamily: MONO }}>{error}</div>
        )}

        <section>
          <Label>Assembly</Label>
          {WAVES.map((w) => {
            const st = waveState(w);
            return (
              <div
                key={w.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "3px 0",
                  fontFamily: MONO,
                  fontSize: 11.5,
                }}
              >
                <span
                  style={{
                    width: 14,
                    textAlign: "center",
                    color: st === "done" ? C.accent : st === "active" ? C.win : "#39424c",
                  }}
                >
                  {st === "done" ? "●" : st === "active" ? "◐" : "○"}
                </span>
                <span style={{ color: st === "done" ? "#cdd6dd" : st === "active" ? "#eef3f5" : C.dim }}>
                  {w.label}
                </span>
                <span style={{ marginLeft: "auto", color: C.faint, fontSize: 10 }}>{w.source}</span>
              </div>
            );
          })}
        </section>

        <section>
          <Label>Layers</Label>
          <Toggle
            on={visible.opportunity}
            onClick={() => setVisible((v) => ({ ...v, opportunity: !v.opportunity }))}
            label="Opportunity"
            swatch={
              <div
                style={{
                  width: 44,
                  height: 9,
                  borderRadius: 3,
                  background:
                    "linear-gradient(90deg,rgba(20,44,66,.5),#1c5a7a,#2b9fae,#57d8cf,#8ff2dd)",
                }}
              />
            }
          />
          <Toggle
            on={visible.competitors}
            onClick={() => setVisible((v) => ({ ...v, competitors: !v.competitors }))}
            label="Competitors"
            swatch={
              <span style={{ width: 44, display: "flex", gap: 4, justifyContent: "center" }}>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    style={{ width: 6, height: 6, borderRadius: "50%", background: C.competitor }}
                  />
                ))}
              </span>
            }
          />
          {/* "Walk catchment" is in the comp and is not here — no isochrones yet. See WAVES. */}
          <Toggle
            on={visible.picks}
            onClick={() => setVisible((v) => ({ ...v, picks: !v.picks }))}
            label="Top picks"
            swatch={
              <span style={{ width: 44, display: "flex", justifyContent: "center" }}>
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: C.win,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: C.bg,
                    fontFamily: MONO,
                    fontSize: 10,
                    fontWeight: 600,
                  }}
                >
                  1
                </span>
              </span>
            }
          />
        </section>

        <section>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
            <Label inline>Re-weight</Label>
            <div style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9, color: C.faint }}>
              instant · client-side
            </div>
          </div>

          {/*
           * Two sliders, not the comp's four.
           *
           * "Low rent" is cut — we hold no rent data of any kind, and the comp fills it with a
           * Gaussian. "Accessibility" waits for Valhalla. "Footfall" is renamed **Residents**,
           * because Kontur counts who lives in a cell and that is not foot traffic. Each control
           * here moves a number that came out of the database. See components/score.ts.
           */}
          {FACTORS.map((f) => (
            <div key={f.id} style={{ opacity: scale ? 1 : 0.4 }}>
              <div
                style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "#b7c0c8" }}
              >
                <span>{f.label}</span>
                <span style={{ fontFamily: MONO, color: C.accent }}>{weights[f.id]}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={weights[f.id]}
                disabled={!scale}
                onChange={(e) => setWeights((w) => ({ ...w, [f.id]: +e.target.value }))}
              />
              {/* The note is what stops "Residents" being read as "Footfall": it names the
                  source and the unit. Rendered at #7c858f rather than the chrome grey because a
                  provenance line nobody can read is decoration — the first screenshot of this
                  rail had it at #4c5560/9px and it was invisible against the blurred map. */}
              <div style={{ fontFamily: MONO, fontSize: 9.5, color: "#7c858f", marginTop: -4, marginBottom: 6 }}>
                {f.note}
              </div>
            </div>
          ))}

          {!neutral && (
            <button onClick={() => setWeights({ ...NEUTRAL })} className="wh-reset">
              ↺ back to the agent&apos;s weighting
            </button>
          )}
        </section>

        {/* No picks ⇒ no heading. An empty "Top picks" panel with a blank space under it reads
            as a thing that failed to load; the section simply not existing yet reads as a thing
            that has not happened yet, which is the truth. */}
        {picks.length > 0 && (
        <section>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <Label inline>Top picks</Label>
            {/*
             * The pins are the agent's ranking, computed at neutral. Dragging a slider recolours
             * the surface underneath them but does NOT re-rank them — re-ranking client-side
             * would produce cells with no `place`, and the caption (which names the agent's #1)
             * would then be describing a pin that is no longer #1. So the pins stay put, their
             * scores update under the new weighting, and the UI says which it is in two words
             * rather than letting the user infer it wrongly.
             */}
            {!neutral && (
              <span style={{ marginLeft: "auto" }}>
                <Chip>RANKED AT NEUTRAL</Chip>
              </span>
            )}
          </div>
          <div style={{ marginTop: 8 }}>
            {picks.map((f) => {
              const p = f.properties;
              const top = p.rank === 1;
              const score = scale ? gapDisplay(p as CellProps, scale, weights) : p.gap;
              return (
                <div
                  key={p.rank}
                  onClick={() => setSelected(p.rank)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    padding: "9px 10px",
                    marginBottom: 6,
                    borderRadius: 9,
                    cursor: "pointer",
                    background: top ? "rgba(250,255,105,.07)" : "rgba(255,255,255,.03)",
                    border: `1px solid ${
                      selected === p.rank
                        ? C.accent
                        : top
                          ? "rgba(250,255,105,.25)"
                          : "rgba(255,255,255,.07)"
                    }`,
                  }}
                >
                  <div
                    style={{
                      flex: "none",
                      width: 26,
                      height: 26,
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: MONO,
                      fontWeight: 600,
                      fontSize: 12,
                      background: top ? C.win : "rgba(255,255,255,.08)",
                      color: top ? C.bg : "#c7cfd6",
                    }}
                  >
                    {p.rank}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* `place` only exists because a point-in-polygon test put the cell inside
                        that polygon (geo.districts). No name ⇒ no line — never a placeholder. */}
                    {p.place && (
                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: "#eef3f5",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.place}
                      </div>
                    )}
                    <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#8a949d", marginTop: 2 }}>
                      {score} / 100 · ~{Number(p.pop).toLocaleString("en")} people · {p.sup} nearby
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        )}

        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 9, paddingTop: 4 }}>
          <button
            onClick={replay}
            disabled={!store.current.competitors || replaying || busy}
            className="wh-replay"
          >
            ↻ Replay assembly
          </button>
          <Attribution />
        </div>
      </div>

      {selected !== null && (
        <Provenance
          pick={picks.find((f) => f.properties.rank === selected)?.properties}
          score={(p) => (scale ? gapDisplay(p as CellProps, scale, weights) : p.gap)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

type PickProps = {
  rank: number;
  gap: number;
  pop: number;
  sup: number;
  h3: string;
  /** Composed by placeName() in trigger/chat.ts. Absent when the cell resolved to no district. */
  place?: string;
};

/**
 * The three pins, as DOM markers.
 *
 * They are the answer, so they win the page: the #1 is larger, carries the yellow, glows, and
 * pulses. Rank 3 lands first and 1 last — counting *up* to the winner, so the climax of the
 * answer is the last thing that moves.
 */
function PickMarkers({
  map,
  ready,
  picks,
  visible,
  onSelect,
}: {
  map: React.RefObject<maplibregl.Map | null>;
  ready: boolean;
  picks: GeoJSON.Feature<GeoJSON.Point, PickProps>[];
  visible: boolean;
  onSelect: (rank: number) => void;
}) {
  const markers = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    markers.current.forEach((mk) => mk.remove());
    markers.current = [];
    if (!picks.length) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const byRank = [...picks].sort((a, b) => b.properties.rank - a.properties.rank);

    byRank.forEach((f, i) => {
      timers.push(
        setTimeout(() => {
          const p = f.properties;
          const top = p.rank === 1;
          const size = top ? 34 : 26;

          /*
           * TWO elements, and the nesting is load-bearing.
           *
           * MapLibre positions a marker by writing `transform: translate(...)` onto the element
           * you hand it — so the root MUST NOT be animated with transform. Animating it directly
           * (as the mockup does) clobbers MapLibre's positioning and parks every pin at the map's
           * top-left corner until the next map move re-runs Marker._update. On a map that has
           * finished flying, there is no next move: the pins simply sit in the corner.
           *
           * Caught by screenshotting the real thing — it typechecks perfectly and looks correct
           * in review. So: `root` is MapLibre's to position, `drop` is ours to animate.
           */
          const root = document.createElement("div");
          root.style.width = `${size}px`;
          root.style.height = `${size}px`;

          const drop = document.createElement("div");
          drop.className = "wh-marker";
          drop.style.opacity = "0";
          drop.style.transform = "translateY(-46px) scale(.5)";
          drop.innerHTML = `<div style="position:relative;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:${
            top ? C.win : "rgba(16,20,26,.92)"
          };border:2px solid ${top ? C.bg : "rgba(255,255,255,.55)"};color:${
            top ? C.bg : "#eef3f5"
          };font-family:${MONO};font-weight:600;font-size:${top ? 15 : 12}px;box-shadow:0 6px 16px -4px rgba(0,0,0,.7)${
            top ? ",0 0 22px -2px rgba(250,255,105,.7)" : ""
          }">${p.rank}${top ? '<span class="wh-ring"></span>' : ""}</div>`;
          drop.onclick = () => onSelect(p.rank);
          root.appendChild(drop);

          const mk = new maplibregl.Marker({ element: root, anchor: "center" })
            .setLngLat(f.geometry.coordinates as [number, number])
            .addTo(m);
          markers.current.push(mk);
          requestAnimationFrame(() => {
            drop.style.opacity = "1";
            drop.style.transform = "translateY(0) scale(1)";
          });
        }, i * 170),
      );
    });

    return () => {
      timers.forEach(clearTimeout);
      markers.current.forEach((mk) => mk.remove());
      markers.current = [];
    };
  }, [map, ready, picks, onSelect]);

  useEffect(() => {
    markers.current.forEach((mk) => (mk.getElement().style.display = visible ? "" : "none"));
  }, [visible, picks]);

  return null;
}

/**
 * "How do you know that?" — answered by the interface rather than by us talking over the demo.
 *
 * The measured/estimated split is the point. Every row here is a number a sceptic can recompute
 * from the two inputs (FR-003), and the dots say which inputs are counted and which are modelled.
 */
function Provenance({
  pick,
  score,
  onClose,
}: {
  pick?: PickProps;
  score: (p: PickProps) => number;
  onClose: () => void;
}) {
  if (!pick) return null;
  const top = pick.rank === 1;
  return (
    <div
      className="wh-pop"
      style={{ border: `1px solid ${top ? "rgba(250,255,105,.4)" : "rgba(255,255,255,.12)"}` }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
        <div
          style={{
            flex: "none",
            width: 26,
            height: 26,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: MONO,
            fontWeight: 600,
            fontSize: 12,
            background: top ? C.win : "rgba(255,255,255,.1)",
            color: top ? C.bg : "#dfe6eb",
          }}
        >
          {pick.rank}
        </div>
        {/* No name ⇒ "Candidate site", never a nearby or plausible-sounding district. */}
        <div style={{ fontWeight: 600, fontSize: 14 }}>{pick.place ?? "Candidate site"}</div>
        <div onClick={onClose} style={{ marginLeft: "auto", cursor: "pointer", color: "#69737d", fontSize: 15, padding: "0 4px" }}>
          ×
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "8px 12px", fontSize: 12.5 }}>
        <span style={{ color: "#98a2ab" }}>Opportunity score</span>
        <span style={{ fontFamily: MONO, fontWeight: 600, color: top ? C.win : C.accent }}>
          {score(pick)} / 100
        </span>
        <span style={{ color: "#98a2ab" }}>Resident demand</span>
        <span style={{ fontFamily: MONO }}>~{Number(pick.pop).toLocaleString("en")} people</span>
        {/*
         * The comp says "Bakeries ≤ 1 km". Two problems, both fixed here.
         *
         * 1. The trade is not always bakeries — this panel must not hardcode the demo question.
         * 2. **"≤ 1 km" is wrong.** Supply is `h3kRing(h3_8, 1)` = the cell plus its six
         *    neighbours. Measured against the live service (2026-07-20), the furthest a counted
         *    competitor can sit from the cell centre is **1.391 km**:
         *
         *      SELECT max(greatCircleDistance(...)) over h3ToGeoBoundary(h3kRing(c,1))
         *        → ring_outer_radius_km: 1.391   (h3EdgeLengthKm(8) = 0.531)
         *
         *    So "≤ 1 km" understates the ring by ~40%, and it is exactly the kind of plausible,
         *    checkable, wrong detail a domain expert on the jury checks first (constitution II).
         *    NB the spec's "~1.2 km across" and CLAUDE.md's "~1 km" are both off too — reported.
         */}
        <span style={{ color: "#98a2ab" }}>Competitors ≤ 1.4 km</span>
        <span style={{ fontFamily: MONO }}>{pick.sup}</span>
      </div>

      <div
        style={{
          marginTop: 13,
          paddingTop: 12,
          borderTop: `1px solid ${C.hair}`,
          display: "flex",
          flexDirection: "column",
          gap: 7,
          fontSize: 11,
        }}
      >
        {/*
         * The comp's first row claims a measured Valhalla walk catchment. We have no isochrones,
         * so that row is replaced by the thing that IS measured here: the competitor count is a
         * count of real POIs in a real H3 ring.
         */}
        <Dot color={C.accent}>
          Supply — <b style={{ color: "#9defdf" }}>measured</b> (Overture; H3 ring = this cell + 6
          neighbours)
        </Dot>
        <Dot color="#9a8cff">
          Population — <b style={{ color: "#c2b8ff" }}>estimated</b> (Kontur, Nov 2023)
        </Dot>
      </div>
    </div>
  );
}

function Dot({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
      <span
        style={{ width: 6, height: 6, borderRadius: "50%", background: color, marginTop: 5, flex: "none" }}
      />
      <span style={{ color: "#b7c0c8", lineHeight: 1.45 }}>{children}</span>
    </div>
  );
}

function Label({ children, inline }: { children: React.ReactNode; inline?: boolean }) {
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: ".14em",
        color: C.dim,
        textTransform: "uppercase",
        marginBottom: inline ? 0 : 8,
      }}
    >
      {children}
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: "accent" }) {
  return (
    <span
      style={{
        padding: "2px 7px",
        borderRadius: 20,
        fontFamily: MONO,
        fontSize: 9.5,
        letterSpacing: ".04em",
        background: tone === "accent" ? "rgba(111,240,224,.14)" : "rgba(255,255,255,.07)",
        color: tone === "accent" ? "#9defdf" : "#98a2ab",
      }}
    >
      {children}
    </span>
  );
}

function Toggle({
  on,
  onClick,
  label,
  swatch,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  swatch: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "5px 0",
        cursor: "pointer",
        opacity: on ? 1 : 0.4,
        transition: "opacity .15s ease",
      }}
    >
      {swatch}
      <span style={{ fontSize: 12 }}>{label}</span>
      <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9.5, color: on ? C.accent : C.dim }}>
        {on ? "on" : "off"}
      </span>
    </div>
  );
}

/**
 * The rail is an instrument floating over a full-bleed map, not a column beside it.
 *
 * The brief asked us to choose between split and map-dominant: the map is the answer, so it gets
 * every pixel, and the rail overlays it. `backdrop-filter` is what makes that legible — the map
 * stays visibly present underneath rather than being occluded by a slab.
 */
const CSS = `
.wh-rail{position:absolute;left:18px;top:18px;bottom:18px;width:344px;z-index:8;display:flex;
  flex-direction:column;gap:14px;padding:16px 16px 18px;overflow-y:auto;border-radius:14px;
  background:${C.panel};backdrop-filter:blur(14px);border:1px solid ${C.hair};
  box-shadow:0 24px 60px -20px rgba(0,0,0,.7)}
.wh-rail::-webkit-scrollbar{width:8px}
.wh-rail::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:4px}
.wh-rail::-webkit-scrollbar-track{background:transparent}
.wh-pill{position:absolute;top:20px;left:50%;transform:translateX(-50%);z-index:6;display:flex;
  align-items:center;gap:9px;padding:7px 15px;border-radius:20px;background:rgba(13,15,18,.82);
  backdrop-filter:blur(12px);border:1px solid ${C.hair};font-family:${MONO};font-size:12px;color:#cdd6dd}
.wh-dot{width:7px;height:7px;border-radius:50%;background:${C.accent};animation:wh-pulse 1s infinite}
.wh-pop{position:absolute;right:18px;top:18px;z-index:9;width:262px;padding:15px;border-radius:13px;
  background:rgba(11,13,16,.9);backdrop-filter:blur(14px);box-shadow:0 24px 60px -20px rgba(0,0,0,.75)}
.wh-ask{width:100%;padding:10px 40px 10px 12px;border-radius:9px;background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.1);color:${C.text};font-family:${MONO};font-size:12.5px;outline:none}
.wh-go{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:28px;height:28px;border:none;
  border-radius:7px;background:${C.accent};color:#062018;font-weight:700;cursor:pointer;font-size:14px}
.wh-go:disabled{opacity:.4;cursor:default}
.wh-replay,.wh-reset{width:100%;padding:9px;border-radius:9px;background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.12);color:#dfe6eb;font-family:${SANS};font-size:12.5px;
  font-weight:500;cursor:pointer}
.wh-reset{margin-top:6px;padding:7px;font-size:11.5px;color:#98a2ab}
.wh-replay:disabled{opacity:.35;cursor:default}
input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:3px;border-radius:3px;
  background:rgba(255,255,255,.14);outline:none;margin:7px 0}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:13px;height:13px;
  border-radius:50%;background:${C.accent};border:2px solid ${C.bg};cursor:pointer;
  box-shadow:0 0 0 1px rgba(111,240,224,.5)}
input[type=range]::-moz-range-thumb{width:13px;height:13px;border-radius:50%;background:${C.accent};
  border:2px solid ${C.bg};cursor:pointer}
input[type=range]:disabled{opacity:.5}
.maplibregl-ctrl-attrib,.maplibregl-ctrl-logo{display:none!important}
.wh-marker{cursor:pointer;transition:transform .5s cubic-bezier(.22,1,.36,1),opacity .35s ease}
.wh-ring{position:absolute;inset:-2px;border-radius:50%;border:2px solid ${C.win};
  animation:wh-ring 1.8s ease-out infinite}
.wh-caret{display:inline-block;width:7px;color:${C.accent};animation:wh-caret 1s step-end infinite}
@keyframes wh-pulse{0%,100%{opacity:.45}50%{opacity:1}}
@keyframes wh-ring{0%{transform:scale(.6);opacity:.9}70%{opacity:0}100%{transform:scale(2.4);opacity:0}}
@keyframes wh-caret{0%,100%{opacity:1}50%{opacity:0}}
@media (prefers-reduced-motion:reduce){
  .wh-marker,.wh-dot,.wh-ring,.wh-caret{animation:none!important;transition:none!important}
}
`;
