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
import {
  mintChatAccessToken,
  startChatSession,
  saveSiteAction,
  listSavedSitesAction,
} from "@/app/actions";
import type { SavedSiteRow } from "@/lib/pg";
import { Attribution } from "@/components/attribution";
import {
  FACTORS,
  NEUTRAL,
  fillColor,
  gapDisplay,
  gapExpression,
  isNeutral,
  type CellProps,
  type Weights,
} from "@/components/score";

type Msg = InferChatUIMessage<typeof whereHouseChat>;
type MapPart = Extract<Msg["parts"][number], { type: "data-map" }>;
type LayerData = MapPart["data"];
// The historical-momentum series (feature 004) rides its own `data-trend` part (ADR-001), so the
// full ~54-point monthly series reaches the client while the model only ever saw a two-field summary.
type TrendPart = Extract<Msg["parts"][number], { type: "data-trend" }>;
type TrendData = TrendPart["data"];

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
 * The comp places a 7th wave, "Walk catchment · Valhalla", between competitors and the surface.
 * It cannot go there — the catchment is *of a pick*, so it is ranked last, after `picks` and
 * before the caption (research D5: the comp was drawn before the data existed). Its state is
 * derived the same way as every other layer wave: ● only when the contour is genuinely on the
 * map, ◐ only while `showCatchment` is genuinely running. Never a timer.
 */
const WAVES = [
  { key: "read", label: "Read the question", source: "agent" },
  { key: "competitors", label: "Competitor dots", source: "ClickHouse", tool: "tool-findCompetitors", layer: "competitors" },
  { key: "opportunity", label: "Opportunity surface", source: "ClickHouse", tool: "tool-scoreArea", layer: "opportunity" },
  { key: "picks", label: "Rank top 3", source: "agent", tool: "tool-rankSites", layer: "picks" },
  { key: "catchment", label: "Walk catchment", source: "Valhalla", tool: "tool-showCatchment", layer: "catchment" },
  { key: "caption", label: "Caption", source: "agent" },
] as const;

type WaveState = "pending" | "active" | "done";

/**
 * The composer's suggestion chips. Each is a real message the agent can answer — "compare vs the
 * market" drives compareSavedSites, "why the #1 pick?" asks the agent to defend its own ranking,
 * "show pharmacies instead" re-runs the whole flow for another trade. They send verbatim; nothing
 * here is a canned client-side answer.
 */
const SUGGESTIONS = ["compare vs the market", "why the #1 pick?", "show pharmacies instead"] as const;

/**
 * A grouped agent run for the left rail. `kind` is honest and structural: `rebuild` produced the
 * picks layer (a fresh answer), `steer` produced some other layer but no picks (a nudge to the
 * existing map), `talk` produced no map at all (a pure conversational turn).
 */
type RunKind = "rebuild" | "steer" | "talk";
type RunStep = { key: string; label: string; engine: string; state: WaveState };
type Run = {
  id: string;
  q: string;
  kind: RunKind;
  steps: RunStep[];
  chip: string;
  live: boolean;
  hasLayers: boolean;
};

/** Palette for a run's kind — chrome only, never the pick yellow (which is spent once, on #1). */
const RUN_KIND: Record<RunKind, { label: string; dot: string; bg: string; color: string }> = {
  rebuild: { label: "rebuild", dot: C.accent, bg: "rgba(111,240,224,.14)", color: "#9defdf" },
  steer: { label: "steer", dot: "#8a9bc0", bg: "rgba(138,155,192,.14)", color: "#aeb9d0" },
  talk: { label: "talk", dot: "#69737d", bg: "rgba(255,255,255,.06)", color: "#98a2ab" },
};

/** Per-engine tag styling for a run step (agent / ClickHouse / Valhalla). Chrome greys only. */
const ENGINE_TAG: Record<string, { bg: string; col: string }> = {
  agent: { bg: "rgba(255,255,255,.06)", col: "#98a2ab" },
  ClickHouse: { bg: "rgba(111,240,224,.1)", col: "#9defdf" },
  Valhalla: { bg: "rgba(179,168,255,.12)", col: "#c2b8ff" },
};

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

const LAYER_IDS: LayerId[] = ["opportunity", "competitors", "picks", "catchment", "saved"];

// The teal band for the walk catchment. Kept clear of the competitor warm and the pick yellow so
// the shape reads as "the walk", not a data value: a low-alpha fill under a crisp accent outline.
const CATCHMENT_FILL_OPACITY = 0.14;
const CATCHMENT_LINE_WIDTH = 2;

// The user's saved sites (feature 003, compareSavedSites). Drawn as a HOLLOW ring on purpose:
// competitor dots are filled warm, the pick pins are solid yellow — both are things the app is
// pointing at. A saved site is the user's own, so it must not read as another recommendation; an
// open ring says "yours", not "ours". The ring is badged by today's market gap when the compare
// scored the cell, and stays a neutral grey when it did not (absent != 0 — an unscored save is
// never coloured as gap 0). Endpoints run warm→teal like the choropleth's meaning: low gap =
// saturated market (bad), high gap = underserved (good).
const SAVED_RADIUS = 8;
const SAVED_STROKE_WIDTH = 3;
const SAVED_STROKE: maplibregl.ExpressionSpecification = [
  "case",
  ["has", "marketGap"],
  [
    "interpolate", ["linear"], ["get", "marketGap"],
    0, C.competitor, 40, "#e0b34a", 70, "#57d8cf", 100, "#8ff2dd",
  ],
  "#8a949d",
] as unknown as maplibregl.ExpressionSpecification;

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
      // The walk catchment: fill + outline, drawn OVER the opportunity surface and UNDER the
      // competitor dots and the pick markers, so nothing the contour encloses is hidden by it
      // (contract: under picks, over opportunity). Colour is set once here; the reveal only moves
      // opacity/width, so it never re-derives the teal.
      m.addLayer({
        id: "catchment",
        type: "fill",
        source: "catchment",
        paint: { "fill-color": C.accent, "fill-opacity": 0 },
      });
      m.addLayer({
        id: "catchment-line",
        type: "line",
        source: "catchment",
        paint: { "line-color": C.accent, "line-width": 0, "line-opacity": 0 },
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
      // The user's saved sites: a hollow ring per site, drawn OVER the competitor dots (it is the
      // user's own marker, so it must sit above the market it is being compared against) and UNDER
      // the pick markers. Colour is the marketGap expression; the reveal only moves radius/width/
      // opacity, so the ramp is never re-derived. Empty until compareSavedSites emits the layer.
      m.addLayer({
        id: "saved",
        type: "circle",
        source: "saved",
        paint: {
          "circle-radius": 0,
          // Hollow: no fill, only the ring. This is what separates a saved site from a competitor.
          "circle-color": "rgba(0,0,0,0)",
          "circle-opacity": 0,
          "circle-stroke-width": 0,
          "circle-stroke-color": SAVED_STROKE,
          "circle-stroke-opacity": 0,
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

  // `id` is the chatId the transport keys sessions on (its accessToken/startSession callbacks
  // receive the same value). Saving a pick from the client threads it through so the save lands
  // under the same shortlist scope as the conversation.
  const { messages, sendMessage, setMessages, status, id: chatId } = useChat<Msg>({ transport });
  const [input, setInput] = useState("where should I open a bakery in Berlin?");
  const [error, setError] = useState<string | null>(null);
  const [weights, setWeights] = useState<Weights>({ ...NEUTRAL });
  const [visible, setVisible] = useState<Record<LayerId, boolean>>({
    opportunity: true,
    competitors: true,
    picks: true,
    catchment: true,
    // The compare flow's saved-site layer (feature 003): the user's saved sites as hollow rings,
    // emitted by compareSavedSites and toggled independently below.
    saved: true,
  });
  const [selected, setSelected] = useState<number | null>(null);
  const [replaying, setReplaying] = useState(false);
  /**
   * Which past agent run the map is currently showing. `null` = the live/current data — the
   * incremental paint effect owns the map. A non-null value points the map at a finished run's
   * snapshot (see `runSnapshots`), driven by the top-bar scrub control and the run cards.
   */
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  /** Run ids whose step list is expanded in the left rail. The live run is always shown expanded. */
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
  /**
   * Honest "session resumed" detection: true only when assistant messages were present before the
   * user sent anything this session (i.e. the transport restored a prior conversation). If nothing
   * is ever restored this stays false and the pill is simply never shown — never faked.
   */
  const [resumed, setResumed] = useState(false);
  /**
   * The user's saved history (feature 003). Postgres is authoritative, so this is loaded straight
   * from `listSavedSitesAction` on mount and after every save — it survives a reload because the
   * data lives in Postgres, not in this component. Today's market gap is NOT here (Postgres never
   * scored it); that arrives on the `saved` map layer once compareSavedSites runs, and the panel
   * joins the two by coordinate below.
   */
  const [savedSites, setSavedSites] = useState<SavedSiteRow[]>([]);
  /** Picks whose save is in flight, keyed by h3 — for the row's transient "saving…" state. */
  const [saving, setSaving] = useState<Set<string>>(new Set());
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
  /**
   * Per-run snapshot of the resolved layers, taken when a run finishes. Lets the scrub control
   * replay a PAST run onto the map without touching the live `store` and without re-running the
   * agent — same money-saving discipline as `replay` (a judge will scrub back and forth).
   */
  const runSnapshots = useRef<Map<string, Partial<Record<LayerId, GeoJSON.FeatureCollection>>>>(
    new Map(),
  );
  /** True once the user has sent anything this session — gates the honest "session resumed" pill. */
  const sentThisSession = useRef(false);
  /** Previous `busy`, to catch the true→false edge where a run finishes and gets snapshotted. */
  const prevBusy = useRef(false);

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

  // The latest momentum series (feature 004). Same last-write-wins as the map parts — the tool
  // writes a stable id 'trend', so a re-run updates it in place. Absent until categoryTrend runs,
  // and absent (not a flat-at-zero line) for a trade with too little history: the tool emits no
  // part at all in that case, so `trend` simply stays undefined and the block does not render.
  const trend = useMemo(() => {
    // Scope to the CURRENT answer: read the trend from the LAST assistant message only. Scanning
    // every message kept a prior question's sparkline on screen next to a later answer that emitted
    // no trend part — a stale claim. A new answer without a trend now correctly shows none.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      let out: TrendData | undefined;
      for (const p of m.parts) if (p.type === "data-trend") out = p.data;
      return out;
    }
    return undefined;
  }, [messages]);

  /** The p95 scalars this answer was scored with. Only the opportunity layer carries them. */
  const scale: Scale | undefined = latest.get("opportunity")?.scale;

  const picks = useMemo(() => {
    const fc = store.current.picks;
    void storeVersion; // recompute when a new picks layer lands in the store ref
    return (fc?.features ?? []) as GeoJSON.Feature<GeoJSON.Point, PickProps>[];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, storeVersion]);

  /**
   * The median GAP over the opportunity choropleth's own cells — one number on how underserved the
   * city is for this trade. Computed from the FeatureCollection already fetched and painted
   * (store.current.opportunity), so it costs no extra query. `gap` is ClickHouse's neutral score,
   * the same number the cells are painted with. Absent until the surface lands.
   */
  const medianOpportunity = useMemo(() => {
    void storeVersion;
    const fc = store.current.opportunity;
    if (!fc) return undefined;
    // Score each cell under the CURRENT weights, exactly as the choropleth is painted
    // (gapDisplay == the fill's own expression). At neutral this is ClickHouse's gap; off neutral it
    // tracks the re-weighted surface, so the tile never disagrees with the cells it summarises.
    const gaps = (fc.features as GeoJSON.Feature<GeoJSON.Geometry, CellProps>[])
      .map((f) => {
        const p = f.properties;
        if (!p || typeof p.gap !== "number") return undefined;
        return scale ? gapDisplay(p, scale, weights) : p.gap;
      })
      .filter((g): g is number => typeof g === "number")
      .sort((a, b) => a - b);
    if (!gaps.length) return undefined;
    const mid = gaps.length >> 1;
    return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, storeVersion, scale, weights]);

  // ---- saved sites (feature 003) --------------------------------------------------------

  /**
   * The city + category THIS answer is about, recovered from the picks layer's own label
   * (`top {n} for {category} in {city}`, set in trigger/chat.ts). A save has to carry the same
   * (city, category) the agent's saveSite would — the shortlist is keyed on them — and this is the
   * one place the pair is stated verbatim on the client. `category` may be a group ("food and
   * drink"), which contains no " in " and so survives the greedy split unharmed.
   */
  const answerMeta = useMemo(() => {
    const m = latest.get("picks")?.label.match(/^top \d+ for (.+) in (.+)$/);
    return m ? { category: m[1], city: m[2] } : null;
  }, [latest]);

  /**
   * Today's market gap per saved site, keyed by rounded coordinate — the join between the Postgres
   * list (authoritative, no score) and the `saved` map layer (compareSavedSites re-scored it).
   * Both sides derive lon/lat from the same stored double, so 5-decimal keys match. `marketGap` is
   * absent for a site outside today's scored set (the SQL drops the key — absent != 0).
   */
  const marketByCoord = useMemo(() => {
    void storeVersion;
    const out = new Map<string, SavedProps>();
    for (const f of (store.current.saved?.features ?? []) as GeoJSON.Feature<GeoJSON.Point, SavedProps>[]) {
      const [lon, lat] = f.geometry.coordinates;
      out.set(`${lon.toFixed(5)},${lat.toFixed(5)}`, f.properties);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, storeVersion]);

  /** h3 cells already saved — so a pick row can show its saved state and survive a reload. */
  const savedH3 = useMemo(() => new Set(savedSites.map((s) => s.h3_8)), [savedSites]);

  const reloadSaved = useCallback(async () => {
    try {
      setSavedSites(await listSavedSitesAction());
    } catch {
      // A failed history load is not worth an error banner over the map — the panel simply stays
      // as it was. A real save failure surfaces through setError on the save path instead.
    }
  }, []);

  // Load the history once, on mount. It is Postgres-backed, so this is what makes it survive reload.
  useEffect(() => {
    void reloadSaved();
  }, [reloadSaved]);

  const savePick = useCallback(
    async (f: GeoJSON.Feature<GeoJSON.Point, PickProps>) => {
      const meta = answerMeta;
      const p = f.properties;
      if (!meta || saving.has(p.h3) || savedH3.has(p.h3)) return;
      const [lon, lat] = f.geometry.coordinates;
      setSaving((s) => new Set(s).add(p.h3));
      const res = await saveSiteAction({
        chatId,
        city: meta.city,
        category: meta.category,
        label: p.place ?? "saved site",
        lon,
        lat,
        h3_8: p.h3,
        // The pick's own score. Always present on a ranked pick, so no absent/0 ambiguity here.
        score: p.gap,
      });
      setSaving((s) => {
        const n = new Set(s);
        n.delete(p.h3);
        return n;
      });
      if (res.ok) await reloadSaved();
      else setError(`save: ${res.error}`);
    },
    [answerMeta, chatId, saving, savedH3, reloadSaved],
  );

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

      if (layer === "catchment") {
        src!.setData(fc);
        const fillOn = visible.catchment ? CATCHMENT_FILL_OPACITY : 0;
        const lineOn = visible.catchment ? 1 : 0;
        // The contour draws on: the outline strokes in first (width + opacity growing), the fill
        // washes in a beat behind it. This is the layer arriving from Valhalla, not a decorative
        // fade — same reveal discipline as the surface, one shape instead of 2,260.
        await tween(
          620,
          (t) => {
            m.setPaintProperty("catchment-line", "line-width", CATCHMENT_LINE_WIDTH * Math.min(1, t * 1.4));
            m.setPaintProperty("catchment-line", "line-opacity", lineOn * Math.min(1, t * 1.6));
            m.setPaintProperty("catchment", "fill-opacity", fillOn * Math.max(0, (t - 0.25) / 0.75));
          },
          cancelled,
        );
        if (cancelled()) return;
        m.setPaintProperty("catchment-line", "line-width", CATCHMENT_LINE_WIDTH);
        m.setPaintProperty("catchment-line", "line-opacity", lineOn);
        m.setPaintProperty("catchment", "fill-opacity", fillOn);
        return;
      }

      if (layer === "saved") {
        src!.setData(fc);
        const on = visible.saved ? 1 : 0;
        // The rings draw on: radius and stroke grow together, opacity a beat behind. This is the
        // saved layer arriving from ClickHouse (compareSavedSites), the same reveal discipline as
        // every other layer — never a timer, and only ever a handful of shapes.
        await tween(
          560,
          (t) => {
            const k = Math.min(1, t * 1.3);
            m.setPaintProperty("saved", "circle-radius", SAVED_RADIUS * k);
            m.setPaintProperty("saved", "circle-stroke-width", SAVED_STROKE_WIDTH * k);
            m.setPaintProperty("saved", "circle-stroke-opacity", on * Math.min(1, t * 1.6));
          },
          cancelled,
        );
        if (cancelled()) return;
        m.setPaintProperty("saved", "circle-radius", SAVED_RADIUS);
        m.setPaintProperty("saved", "circle-stroke-width", SAVED_STROKE_WIDTH);
        m.setPaintProperty("saved", "circle-stroke-opacity", on);
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
          ? weights.accessibility > 0
            ? // Accessibility is weighted in (which includes NEUTRAL) ⇒ a cell with no measured
              // walk cannot be scored on it and must not be coloured as if it could. It branches
              // on ["has","acc"] to a distinct "not measured" hue, its prominence driven by the
              // cell's FIXED two-factor score — gapExpression(scale, NEUTRAL), NOT the live weights.
              // This is load-bearing (research D3, FR-009a): the not-measured opacity is a stable
              // "this cell would have been worth caring about" signal and must not be re-weighted by
              // the sliders. With the live weights it collapses — pull Accessibility to 100 and the
              // other two to 0 (a valid state, verify-score.mjs even probes {0,0,100}) and every
              // remaining exponent goes to 0, each factor to ^0=1, the product to 100, so ALL 830
              // unmeasured cells blaze at full opacity: the exact flat-fill FR-009a bans, worst
              // precisely when the user says "I only care about the walk". Fixed neutral keeps the
              // 735 already-faint cells faint and lets the ~6 real ones announce themselves whatever
              // the sliders do. At accessibility weight 0 this branch is skipped and unmeasured
              // cells rejoin the normal ramp — no special case, it falls out of the weight (FR-009b).
              ([
                "case",
                ["has", "acc"],
                fillColor(scale, weights),
                [
                  "interpolate", ["linear"], gapExpression(scale, NEUTRAL),
                  0, "rgba(120,132,148,0)", 15, "rgba(132,142,158,0.14)", 40, "rgba(150,159,176,0.44)",
                  70, "rgba(174,183,199,0.6)", 100, "rgba(198,206,220,0.72)",
                ],
              ] as unknown as maplibregl.ExpressionSpecification)
            : fillColor(scale, weights)
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
            // The map now lives inside the centre column, so the padding is modest and symmetric
            // (was left:380 to clear the old floating rail). A little extra at the bottom keeps the
            // caption overlay from covering the fitted bounds.
            m.fitBounds([w, s, e, n], { padding: { top: 60, right: 60, bottom: 96, left: 60 }, duration: 900, maxZoom: 13 });
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
    // Independent toggle: this touches only the catchment's own layers, never another (FR-005).
    if (m.getLayer("catchment")) {
      m.setPaintProperty("catchment", "fill-opacity", visible.catchment ? CATCHMENT_FILL_OPACITY : 0);
      m.setPaintProperty("catchment-line", "line-opacity", visible.catchment ? 1 : 0);
    }
    // Likewise: toggling the saved rings touches only the saved layer, never picks or competitors.
    if (m.getLayer("saved")) {
      m.setPaintProperty("saved", "circle-stroke-opacity", visible.saved ? 1 : 0);
    }
  }, [ready, map, visible]);

  /**
   * Replay the assembly from data we already hold.
   *
   * It **must not** re-run the agent: every run costs real money against a $4.87 LLM budget, and
   * a judge will press this button more than once. Nothing here talks to Trigger.dev or the
   * model — the GeoJSON is in `store`, and what replays is the client-side choreography.
   */
  const replayFrom = useCallback(
    async (snapshot: Partial<Record<LayerId, GeoJSON.FeatureCollection>>) => {
      const m = map.current;
      if (!m || replaying) return;
      const myGen = ++gen.current;
      setReplaying(true);
      setSelected(null);

      m.setPaintProperty("opportunity", "fill-opacity", 0);
      m.setPaintProperty("opportunity-line", "line-opacity", 0);
      m.setPaintProperty("competitors", "circle-opacity", 0);
      m.setPaintProperty("competitors", "circle-radius", 0);
      if (m.getLayer("catchment")) {
        m.setPaintProperty("catchment", "fill-opacity", 0);
        m.setPaintProperty("catchment-line", "line-opacity", 0);
        m.setPaintProperty("catchment-line", "line-width", 0);
      }
      if (m.getLayer("saved")) m.setPaintProperty("saved", "circle-stroke-opacity", 0);
      // The layers absent from this snapshot must not linger from whatever was last on the map:
      // clear every source, then the reveal below re-adds only the ones this run actually produced.
      for (const id of LAYER_IDS)
        if (!snapshot[id]) (m.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
      await sleep(120);

      for (const w of WAVES) {
        if (gen.current !== myGen) break;
        if (!("layer" in w)) continue;
        const fc = snapshot[w.layer as LayerId];
        if (!fc) continue;
        await paint(m, w.layer as LayerId, fc, myGen);
        await sleep(150);
      }
      if (gen.current === myGen) setReplaying(false);
    },
    [map, paint, replaying],
  );

  /** Replay the CURRENT answer's assembly. Thin wrapper over replayFrom so the two never diverge. */
  const replay = useCallback(() => replayFrom(store.current), [replayFrom]);

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

  // The chip and the counter are claims about what is on screen, so they read the same live state
  // the map does. A catchment part only exists when Valhalla measured one (the tool emits nothing
  // otherwise — contract), so `latest.has("catchment")` IS the measured-contour test; the toggle
  // gates whether it is actually visible (FR-003). `notMeasured` is per-answer, from ClickHouse.
  const catchmentShown = latest.has("catchment") && visible.catchment;
  const notMeasured = latest.get("opportunity")?.notMeasured;

  // ---- KPI strip (feature 006, now the map's dashboard header) ---------------------------
  // Every tile is computed from data the client ALREADY holds — no extra tool or query — and each
  // is absent until its own layer lands (absent != 0: a missing datum is never rendered as 0; a
  // tile that has no datum shows "awaiting …", not a fabricated number).
  const competitorCount = latest.get("competitors")?.rowCount;
  // The #1 pick's score out of 100 — computed under the CURRENT weights exactly as the Top-picks
  // table renders it (gapDisplay), so the two never show different numbers for the same pick when a
  // slider moves.
  const pick1 = picks.find((f) => f.properties.rank === 1)?.properties;
  const topScore = pick1 ? (scale ? gapDisplay(pick1 as CellProps, scale, weights) : pick1.gap) : undefined;

  // ---- agent runs (the left-rail centerpiece) -------------------------------------------
  // The conversation, grouped into runs: each user turn opens a run; the assistant turns until the
  // next user turn belong to it. `kind`, `steps` and `chip` are derived from REAL parts — tool
  // state and `data-map` parts landing — never from a timer (constitution: the assembly is
  // computed, not choreographed). Past runs show every step done; the live (last, streaming) run
  // reads its step states from the same live signals the map does.
  const runs = useMemo<Run[]>(() => {
    type Raw = {
      id: string;
      q: string;
      tools: Map<string, string>;
      map: Map<LayerId, LayerData>;
      text: boolean;
    };
    const raw: Raw[] = [];
    let cur: Raw | null = null;
    for (const msg of messages) {
      if (msg.role === "user") {
        const q = msg.parts
          .filter((p): p is Extract<Msg["parts"][number], { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("");
        cur = { id: msg.id, q, tools: new Map(), map: new Map(), text: false };
        raw.push(cur);
      } else if (msg.role === "assistant" && cur) {
        for (const p of msg.parts as unknown as { type: string; state?: string; data?: LayerData }[]) {
          if (p.type.startsWith("tool-")) cur.tools.set(p.type, p.state ?? "");
          else if (p.type === "data-map" && p.data) cur.map.set(p.data.layer, p.data);
          else if (p.type === "text") cur.text = true;
        }
      }
    }
    return raw.map((r, i) => {
      const isLast = i === raw.length - 1;
      const live = isLast && busy;
      // Honest classification: a run that produced the picks layer rebuilt the answer; one that
      // produced any other layer but no picks steered it; one that produced no map at all is talk.
      const kind: RunKind = r.map.has("picks") ? "rebuild" : r.map.size > 0 ? "steer" : "talk";
      const steps: RunStep[] = [];
      for (const w of WAVES) {
        let present: boolean;
        if (w.key === "read") present = true;
        else if (w.key === "caption") present = r.text || (isLast && caption.length > 0);
        else present = "tool" in w && r.tools.has((w as { tool: string }).tool);
        if (!present) continue;
        // Live run: its true streamed state. Past runs: settled, every step done.
        const state: WaveState = live ? waveState(w) : "done";
        steps.push({ key: w.key, label: w.label, engine: w.source, state });
      }
      const comp = r.map.get("competitors")?.rowCount;
      const chip =
        comp !== undefined
          ? `${comp.toLocaleString("en")} competitors`
          : r.map.size > 0
            ? "map updated"
            : "reply";
      return { id: r.id, q: r.q, kind, steps, chip, live, hasLayers: r.map.size > 0 };
    });
    // waveState/caption/latest all move with `messages`+`busy`; `signature` covers layer changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, busy, caption, signature]);

  const liveRunId = runs.length ? runs[runs.length - 1].id : null;
  const viewingId = selectedRunId ?? liveRunId;
  const viewingIdx = runs.findIndex((r) => r.id === viewingId);
  const scrubLabel = runs.length
    ? `run ${(viewingIdx < 0 ? runs.length : viewingIdx + 1)} / ${runs.length}`
    : "—";
  const canScrub = runs.length > 1;
  const stepRun = (delta: number) => {
    if (!runs.length) return;
    const base = viewingIdx < 0 ? runs.length - 1 : viewingIdx;
    const next = Math.max(0, Math.min(runs.length - 1, base + delta));
    setSelectedRunId(runs[next].id);
  };
  const toggleRun = (id: string) =>
    setOpenRuns((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // The pins the map is currently showing: the live picks, or a scrubbed run's snapshotted picks.
  const displayPicks = useMemo(() => {
    if (selectedRunId && selectedRunId !== liveRunId) {
      const snap = runSnapshots.current.get(selectedRunId);
      return (snap?.picks?.features ?? []) as GeoJSON.Feature<GeoJSON.Point, PickProps>[];
    }
    return picks;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId, liveRunId, picks]);

  // Snapshot the resolved layers when a run finishes (busy true→false), so scrub can replay it.
  useEffect(() => {
    if (prevBusy.current && !busy) {
      const finished = runs[runs.length - 1];
      if (finished && Object.keys(store.current).length > 0)
        runSnapshots.current.set(finished.id, { ...store.current });
    }
    prevBusy.current = busy;
  }, [busy, runs]);

  // Scrub: when the user selects a past run, replay its snapshot onto the map; selecting the live
  // run (or returning to it) restores the current data. Guarded so it never fights the live paint —
  // it only fires on an actual selection change, and replayFrom no-ops while a reveal is running.
  useEffect(() => {
    if (!ready || !map.current) return;
    if (selectedRunId === null || selectedRunId === liveRunId) {
      void replayFrom(store.current);
      return;
    }
    const snap = runSnapshots.current.get(selectedRunId);
    if (snap) void replayFrom(snap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId]);

  // Honest "session resumed": true only if the transport restored assistant messages before the
  // user sent anything this session. With no persistence this never fires and the pill stays hidden.
  useEffect(() => {
    if (!sentThisSession.current && messages.some((m) => m.role === "assistant")) setResumed(true);
  }, [messages]);

  /**
   * Ask the agent. Same reset-on-submit as before (store/painted/gen cleared, box emptied) so the
   * happy path is untouched; additionally returns the map to live-follow. The run stack keeps the
   * full history regardless, which is where a conversational turn stays visible.
   */
  const ask = useCallback(
    (text: string) => {
      if (!text.trim() || busy) return;
      setError(null);
      setSelected(null);
      setSelectedRunId(null);
      sentThisSession.current = true;
      store.current = {};
      painted.current.clear();
      gen.current++;
      sendMessage({ text });
      setInput("");
    },
    [busy, sendMessage],
  );

  /** Clear the session and the map — the top-bar ⟲. Wipes client state; Postgres history is kept. */
  const resetSession = useCallback(() => {
    gen.current++;
    store.current = {};
    painted.current.clear();
    runSnapshots.current.clear();
    setSelected(null);
    setSelectedRunId(null);
    setError(null);
    setResumed(false);
    setMessages([]);
    const m = map.current;
    if (m && m.getLayer("opportunity")) {
      for (const id of LAYER_IDS)
        (m.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
      m.setPaintProperty("opportunity", "fill-opacity", 0);
      m.setPaintProperty("opportunity-line", "line-opacity", 0);
      m.setPaintProperty("competitors", "circle-opacity", 0);
      m.setPaintProperty("competitors", "circle-radius", 0);
      if (m.getLayer("catchment")) {
        m.setPaintProperty("catchment", "fill-opacity", 0);
        m.setPaintProperty("catchment-line", "line-opacity", 0);
      }
      if (m.getLayer("saved")) m.setPaintProperty("saved", "circle-stroke-opacity", 0);
    }
    bumpStore();
  }, [setMessages]);

  const liveText = busy ? "assembling" : "ready";
  const lastRun = runs.length ? runs[runs.length - 1] : null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "302px 1fr 316px",
        gridTemplateRows: "46px 1fr",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: C.bg,
        fontFamily: SANS,
        color: C.text,
      }}
    >
      <style>{CSS}</style>

      {/* ============================ TOP BAR ============================ */}
      <div className="wh-topbar">
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <div
            style={{
              width: 20,
              height: 20,
              borderRadius: 5,
              background: C.win,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ width: 8, height: 8, borderRadius: "50%", border: `2px solid ${C.bg}` }} />
          </div>
          <div style={{ fontWeight: 700, fontSize: 14.5, letterSpacing: "-.01em" }}>WhereHouse</div>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 9.5,
              letterSpacing: ".1em",
              color: C.dim,
              textTransform: "uppercase",
              paddingTop: 1,
            }}
          >
            site selection terminal
          </div>
        </div>

        {/* Live status, driven by the real run state: pulsing "assembling" while busy, steady
            "ready" when idle. The dot never wears the pick yellow (chrome only). */}
        <div
          style={{
            marginLeft: 14,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: MONO,
            fontSize: 11,
            color: "#9aa4ad",
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: C.accent,
              animation: busy ? "wh-pulse 1s infinite" : "none",
            }}
          />
          <span>{liveText}</span>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {/* Only shown when the transport genuinely restored a prior conversation (see `resumed`).
              With no persistence it never appears — never faked. */}
          {resumed && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontFamily: MONO,
                fontSize: 9.5,
                color: "#8a949d",
                padding: "3px 9px",
                borderRadius: 20,
                background: "rgba(111,240,224,.08)",
                border: "1px solid rgba(111,240,224,.2)",
              }}
            >
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: C.accent }} />
              session resumed
            </div>
          )}
          {/* Scrub the map through past agent runs. Subtle/disabled until there is more than one. */}
          <div className="wh-scrub" style={{ opacity: canScrub ? 1 : 0.5 }}>
            <div
              onClick={() => canScrub && stepRun(-1)}
              title="rewind map to the previous run"
              className="wh-scrub-btn"
            >
              ◀
            </div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: "#8a949d", minWidth: 52, textAlign: "center" }}>
              {scrubLabel}
            </div>
            <div
              onClick={() => canScrub && stepRun(1)}
              title="advance the map to the next run"
              className="wh-scrub-btn"
            >
              ▶
            </div>
          </div>
          <div onClick={resetSession} title="clear the session" className="wh-topreset">
            ⟲
          </div>
        </div>
      </div>

      {/* ======================= LEFT: AGENT RUNS ======================= */}
      <div className="wh-col-left">
        <div className="wh-col-head">
          <Label inline>Agent runs</Label>
          <div style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9, color: "#4c5560" }}>
            chat.agent()
          </div>
        </div>

        <div className="wh-scroll wh-runs">
          {runs.length === 0 && (
            <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, padding: "8px 2px", lineHeight: 1.6 }}>
              no runs yet — ask a question below to start the assembly.
            </div>
          )}
          {runs.map((r) => {
            const open = openRuns.has(r.id) || r.live;
            const active = r.id === viewingId;
            const kindC = RUN_KIND[r.kind];
            return (
              <div
                key={r.id}
                style={{
                  marginBottom: 9,
                  borderRadius: 10,
                  background: active ? "rgba(111,240,224,.05)" : "rgba(255,255,255,.02)",
                  border: `1px solid ${active ? "rgba(111,240,224,.22)" : "rgba(255,255,255,.06)"}`,
                }}
              >
                <div
                  onClick={() => setSelectedRunId(r.id)}
                  style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "10px 11px", cursor: "pointer" }}
                >
                  <div
                    title={r.kind}
                    style={{ flex: "none", marginTop: 4, width: 8, height: 8, borderRadius: "50%", background: kindC.dot }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        lineHeight: 1.35,
                        color: active ? "#eef3f5" : "#c7cfd6",
                        fontWeight: active ? 600 : 400,
                        textWrap: "pretty",
                      }}
                    >
                      {r.q}
                    </div>
                    <div
                      style={{
                        marginTop: 5,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontFamily: MONO,
                        fontSize: 9,
                        letterSpacing: ".03em",
                      }}
                    >
                      <span style={{ padding: "1px 6px", borderRadius: 20, background: kindC.bg, color: kindC.color }}>
                        {kindC.label}
                      </span>
                      <span style={{ color: "#5c6771" }}>{r.chip}</span>
                      {r.live && <span style={{ color: "#f0d878" }}>· live</span>}
                    </div>
                  </div>
                  {r.steps.length > 0 && (
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRun(r.id);
                      }}
                      style={{ flex: "none", color: "#69737d", fontSize: 10, padding: "2px 3px", cursor: "pointer" }}
                    >
                      {open ? "▾" : "▸"}
                    </div>
                  )}
                </div>

                {open && r.steps.length > 0 && (
                  <div style={{ padding: "2px 12px 11px 30px" }}>
                    {r.steps.map((st) => {
                      const eng = ENGINE_TAG[st.engine] ?? ENGINE_TAG.agent;
                      return (
                        <div
                          key={st.key}
                          style={{ display: "flex", alignItems: "center", gap: 8, padding: "2.5px 0", fontFamily: MONO, fontSize: 10.5 }}
                        >
                          <span
                            style={{
                              width: 11,
                              textAlign: "center",
                              color: st.state === "done" ? C.accent : st.state === "active" ? "#f0d878" : "#39424c",
                            }}
                          >
                            {st.state === "done" ? "●" : st.state === "active" ? "◐" : "○"}
                          </span>
                          <span style={{ color: st.state === "pending" ? C.dim : "#cdd6dd" }}>{st.label}</span>
                          <span
                            style={{
                              marginLeft: "auto",
                              fontSize: 8.5,
                              letterSpacing: ".05em",
                              padding: "0 5px",
                              borderRadius: 10,
                              background: eng.bg,
                              color: eng.col,
                            }}
                          >
                            {st.engine}
                          </span>
                        </div>
                      );
                    })}
                    {/* A finished run that produced layers can be re-thrown onto the map — same
                        client-side choreography as Replay, no agent, no spend. */}
                    {!r.live && r.hasLayers && (
                      <div
                        onClick={() => setSelectedRunId(r.id)}
                        style={{
                          marginTop: 8,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "4px 10px",
                          borderRadius: 7,
                          background: "rgba(255,255,255,.05)",
                          border: "1px solid rgba(255,255,255,.1)",
                          color: "#cdd6dd",
                          fontSize: 10.5,
                          cursor: "pointer",
                        }}
                      >
                        ▶ replay this run onto the map
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* The composer: the same input + send the rail used to carry, now pinned to the bottom of
            the run stack. Steering indicator while streaming, then the suggestion chips. */}
        <div className="wh-composer">
          {busy && (
            <div
              style={{
                marginBottom: 7,
                display: "flex",
                alignItems: "center",
                gap: 7,
                fontFamily: MONO,
                fontSize: 9.5,
                color: "#f0d878",
              }}
            >
              <span className="wh-spin" />
              steering allowed — nudge the run mid-flight
            </div>
          )}
          {error && (
            <div style={{ color: C.competitor, fontSize: 11, fontFamily: MONO, marginBottom: 7 }}>{error}</div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(input);
            }}
            style={{ position: "relative", margin: 0 }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="where should I open a bakery in Berlin?"
              className="wh-ask"
            />
            <button type="submit" aria-label="send" disabled={busy} className="wh-go">
              →
            </button>
          </form>
          <div style={{ marginTop: 7, display: "flex", gap: 5, flexWrap: "wrap" }}>
            {SUGGESTIONS.map((s) => (
              <div key={s} onClick={() => ask(s)} className="wh-chip">
                {s}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ==================== CENTER: KPI STRIP + MAP ==================== */}
      <div className="wh-col-center">
        {/* KPI strip: four tiles, each ABSENT (never 0) until its own datum lands. Same values the
            rail's "market at a glance" showed, now framing the map. */}
        <div className="wh-kpi">
          <div className="wh-tile">
            <div className="wh-tile-label">Competitors</div>
            {competitorCount !== undefined ? (
              <div className="wh-tile-val">
                <span className="wh-tile-num">{competitorCount.toLocaleString("en")}</span>
                <span className="wh-tile-unit">in view</span>
              </div>
            ) : (
              <div className="wh-tile-absent">awaiting layer</div>
            )}
          </div>

          <div className="wh-tile">
            <div className="wh-tile-label" style={{ display: "flex", alignItems: "center", gap: 5 }}>
              Top opportunity
              {/* The one legitimate pick-yellow dot in the chrome: it stands for the #1 pick. */}
              <span
                style={{ width: 6, height: 6, borderRadius: "50%", background: topScore !== undefined ? C.win : "#39424c" }}
              />
            </div>
            {topScore !== undefined ? (
              <div className="wh-tile-val">
                <span className="wh-tile-num">{Math.round(topScore)}</span>
                <span className="wh-tile-unit">/ 100 · pick #1</span>
              </div>
            ) : (
              <div className="wh-tile-absent">awaiting ranking</div>
            )}
          </div>

          <div className="wh-tile">
            <div className="wh-tile-label">Median opportunity</div>
            {medianOpportunity !== undefined ? (
              <div className="wh-tile-val">
                <span className="wh-tile-num">{Math.round(medianOpportunity)}</span>
                <span className="wh-tile-unit">/ 100 · all cells</span>
              </div>
            ) : (
              <div className="wh-tile-absent">awaiting surface</div>
            )}
          </div>

          <div className="wh-tile">
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div className="wh-tile-label">Momentum</div>
              {trend && (
                <div
                  style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 8, color: "#565f69" }}
                  title="relative momentum from OSM edit history — not an absolute count"
                >
                  since &apos;{String(trend.fromYear).slice(-2)}
                </div>
              )}
            </div>
            {trend ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2, minWidth: 0 }}>
                {trend.enoughHistory && trend.monthly.length > 1 ? (
                  <div style={{ width: 76, flex: "none" }}>
                    <Sparkline points={trend.monthly.map((m) => m.count)} rising={trend.direction === "rising"} />
                  </div>
                ) : (
                  // absent != 0: too little history draws a dashed baseline, never a fabricated trend.
                  <svg width="76" height="30" viewBox="0 0 118 34" style={{ flex: "none" }}>
                    <line x1="2" y1="17" x2="116" y2="17" stroke="#3a434d" strokeWidth="1.4" strokeDasharray="3 4" />
                  </svg>
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: trend.direction === "rising" ? C.accent : "#b7c0c8" }}>
                      {trend.direction}
                    </span>
                    {trend.pctChange != null && (
                      <span style={{ fontFamily: MONO, fontSize: 11, color: "#8a949d" }}>
                        {trend.pctChange >= 0 ? "+" : ""}
                        {trend.pctChange}%
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 8, color: "#565f69", marginTop: 1 }}>OSM history · ohsome</div>
                </div>
              </div>
            ) : (
              <div className="wh-tile-absent">awaiting history</div>
            )}
          </div>
        </div>

        {/* The map well — the MapLibre map lives here now, inside the centre column. */}
        <div className="wh-well">
          <div ref={container} style={{ position: "absolute", inset: 0 }} />

          <PickMarkers map={map} ready={ready} picks={displayPicks} visible={visible.picks} onSelect={setSelected} />

          {/* Transient status, top-centre of the well. The only indeterminate indicator, gone the
              moment there is something real to look at. */}
          {statusText && (
            <div className="wh-well-pill">
              <span className="wh-dot" />
              <span>{statusText}</span>
            </div>
          )}

          {/* The caption: whatever the model streamed — never a sentence written here. The caret
              blinks only while tokens still arrive. Measured/estimated chips as before. */}
          {caption && (
            <div className="wh-caption">
              {lastRun && (
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: RUN_KIND[lastRun.kind].dot }} />
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 9,
                      letterSpacing: ".08em",
                      color: "#8a949d",
                      textTransform: "uppercase",
                    }}
                  >
                    {RUN_KIND[lastRun.kind].label}
                  </span>
                </div>
              )}
              <div style={{ fontSize: 14, lineHeight: 1.5, color: "#eaf1f2", textWrap: "pretty" }}>
                {caption}
                {busy && <span className="wh-caret">▋</span>}
              </div>
              <div style={{ marginTop: 9, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {catchmentShown && <Chip tone="accent">CATCHMENT · MEASURED</Chip>}
                <Chip tone="accent">SUPPLY · MEASURED</Chip>
                <Chip>DEMAND · EST. 2023</Chip>
              </div>
            </div>
          )}

          {/* Legend, top-right of the well. Each row appears only for a layer genuinely on the map
              and visible, so the key never describes something that is not there. */}
          {((latest.has("opportunity") && visible.opportunity) ||
            (latest.has("competitors") && visible.competitors) ||
            catchmentShown) && (
            <div className="wh-legend">
              {latest.has("opportunity") && visible.opportunity && (
                <div className="wh-legend-row">
                  <span
                    style={{
                      width: 34,
                      height: 7,
                      borderRadius: 3,
                      background: "linear-gradient(90deg,rgba(22,46,68,.6),#1c5a7a,#2b9fae,#57d8cf,#8ff2dd)",
                    }}
                  />
                  <span style={{ color: "#9aa4ad" }}>opportunity · est.</span>
                </div>
              )}
              {latest.has("competitors") && visible.competitors && (
                <div className="wh-legend-row">
                  <span style={{ width: 34, display: "flex", justifyContent: "center", gap: 3 }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: C.competitor }} />
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: C.competitor }} />
                  </span>
                  <span style={{ color: "#9aa4ad" }}>competitors · measured</span>
                </div>
              )}
              {catchmentShown && (
                <div className="wh-legend-row">
                  <span style={{ width: 34, display: "flex", justifyContent: "center" }}>
                    <span
                      style={{
                        width: 22,
                        height: 9,
                        borderRadius: 5,
                        background: "rgba(111,240,224,.14)",
                        border: `1px solid ${C.accent}`,
                      }}
                    />
                  </span>
                  <span style={{ color: "#9aa4ad" }}>10-min walk · measured</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ================= RIGHT: ANSWER + CONTROLS ================= */}
      <div className="wh-scroll wh-col-right">
        {/* No picks ⇒ no heading. An empty "Top picks" panel reads as a failed load; the section
            simply not existing yet reads as "not happened yet", which is the truth. */}
        {picks.length > 0 && (
          <section>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <Label inline>Top picks</Label>
              {/* The pins are the agent's ranking, computed at neutral. Dragging a slider recolours
                  the surface but does NOT re-rank; the UI says which it is in two words. */}
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
                const isSaved = savedH3.has(p.h3);
                const isSaving = saving.has(p.h3);
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
                      {/* `place` only exists because a point-in-polygon test put the cell inside that
                          polygon. No name ⇒ no line — never a placeholder. */}
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
                      {/* EDITORIAL neighbourhood-fit (feature 005). Present ONLY when the ring holds a
                          complementary trade; absent != 0, never a "0". Chrome-grey tag, never accent. */}
                      {p.topNeighbours && p.topNeighbours.length > 0 && (
                        <div
                          style={{
                            fontFamily: MONO,
                            fontSize: 9.5,
                            color: "#7c858f",
                            marginTop: 3,
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          <span
                            style={{
                              flex: "none",
                              fontSize: 8,
                              letterSpacing: ".1em",
                              textTransform: "uppercase",
                              padding: "1px 4px",
                              borderRadius: 3,
                              background: "rgba(255,255,255,.06)",
                              color: "#8a949d",
                            }}
                          >
                            editorial
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                            {p.topNeighbours
                              .slice(0, 3)
                              .map((nb) => nb.category.replace(/_/g, " "))
                              .join(" · ")}{" "}
                            nearby
                          </span>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void savePick(f);
                      }}
                      disabled={!answerMeta || isSaving || isSaved}
                      className={isSaved ? "wh-save wh-save-done" : "wh-save"}
                    >
                      {isSaved ? "✓ saved" : isSaving ? "saving…" : "save"}
                    </button>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 5, fontFamily: MONO, fontSize: 8.5, color: "#565f69", lineHeight: 1.5 }}>
              ◆ editorial affinity · a hand-authored heuristic, not data
            </div>
          </section>
        )}

        {/* Saved history. Like Top picks, no saves ⇒ no heading. Postgres-backed, survives reload;
            today's market gap is joined in from the compareSavedSites layer by coordinate. */}
        {savedSites.length > 0 && (
          <section>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <Label inline>Your saved sites</Label>
              <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9, color: C.faint }}>
                {savedSites.length}
              </span>
            </div>
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              {savedSites.map((s) => {
                const props = marketByCoord.get(`${s.lon.toFixed(5)},${s.lat.toFixed(5)}`);
                const gap = props?.marketGap;
                return (
                  <div key={s.id} className="wh-saved-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
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
                        {s.label}
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#8a949d", marginTop: 2 }}>
                        {/* An unscored save renders "unscored", never 0. */}
                        {s.score != null ? `${s.score} / 100` : "unscored"} · {s.status}
                      </div>
                    </div>
                    {/* Today's market gap, from compareSavedSites. Absent — not 0 — outside today's
                        scored set, so a dash rather than a number. */}
                    <div style={{ textAlign: "right", flex: "none" }}>
                      <div
                        style={{
                          fontFamily: MONO,
                          fontSize: 9,
                          letterSpacing: ".08em",
                          color: C.faint,
                          textTransform: "uppercase",
                        }}
                      >
                        today
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 13, color: gap != null ? C.accent : C.dim }}>
                        {gap != null ? gap : "—"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Ask the agent to run compareSavedSites — a chat message, not a direct tool call. */}
            <button
              onClick={() => {
                if (busy) return;
                setError(null);
                sendMessage({ text: "How do my saved sites compare to the market?" });
              }}
              disabled={busy}
              className="wh-compare"
            >
              Compare vs the market
            </button>
          </section>
        )}

        <section>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
            <Label inline>Re-weight</Label>
            <div style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9, color: C.faint }}>
              instant · client-side
            </div>
          </div>

          {/* Three sliders (not the comp's four): "Low rent" is cut (no rent data), "Footfall" is
              renamed Residents (Kontur counts who lives in a cell, not foot traffic). Maps over
              FACTORS, so Accessibility appears automatically. See components/score.ts. */}
          {FACTORS.map((f) => (
            <div key={f.id} style={{ opacity: scale ? 1 : 0.4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "#b7c0c8" }}>
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
                  background: "linear-gradient(90deg,rgba(20,44,66,.5),#1c5a7a,#2b9fae,#57d8cf,#8ff2dd)",
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
                  <span key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: C.competitor }} />
                ))}
              </span>
            }
          />
          {/* The not-measured counter lives with the surface it describes; only meaningful while
              Accessibility is weighted in (FR-010). */}
          {weights.accessibility > 0 && notMeasured !== undefined && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "2px 0 5px 54px",
                fontFamily: MONO,
                fontSize: 10,
                color: "#8a949d",
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "rgba(174,183,199,0.7)", flex: "none" }} />
              {notMeasured.toLocaleString("en")} cells · not measured
            </div>
          )}
          <Toggle
            on={visible.catchment}
            onClick={() => setVisible((v) => ({ ...v, catchment: !v.catchment }))}
            label="Walk catchment"
            swatch={
              <span style={{ width: 44, display: "flex", justifyContent: "center" }}>
                <span
                  style={{
                    width: 20,
                    height: 11,
                    borderRadius: 6,
                    background: "rgba(111,240,224,.14)",
                    border: `1px solid ${C.accent}`,
                  }}
                />
              </span>
            }
          />
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
          <Toggle
            on={visible.saved}
            onClick={() => setVisible((v) => ({ ...v, saved: !v.saved }))}
            label="Saved sites"
            swatch={
              <span style={{ width: 44, display: "flex", justifyContent: "center" }}>
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    border: "2px solid #8a949d",
                    background: "transparent",
                  }}
                />
              </span>
            }
          />
        </section>

        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 9, paddingTop: 8 }}>
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
  /**
   * EDITORIAL neighbourhood-fit (feature 005) — a hand-authored heuristic, NOT a measurement and
   * NOT part of the GAP ranking. rankSites attaches these ONLY when the pick's H3 ring holds at
   * least one complementary trade; a pick with none carries neither key (absent != 0 — never a
   * "fit 0" fact, FR-006), so the row simply shows nothing. See trigger/chat.ts / scoring.ts.
   */
  fit?: number;
  topNeighbours?: { category: string; n: number; w: number }[];
};

/**
 * The `saved` layer's per-feature properties, assembled in savedSitesGeoJsonSql (trigger/scoring.ts).
 * `label`/`status`/`savedScore` are always present; `marketGap`/`residents`/`rivals` exist ONLY when
 * today's surface scored the cell — a site outside the scored set carries none of them (absent != 0,
 * so the panel shows a dash, never a 0).
 */
type SavedProps = {
  label: string;
  status: string;
  savedScore: number;
  marketGap?: number;
  residents?: number;
  rivals?: number;
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

/**
 * A stat tile for the "market at a glance" strip (feature 006): a muted MONO label over a prominent
 * value in the text ink. At most one value in the strip takes the accent (the #1 pick's score, set
 * by the caller); the pick yellow C.win is never spent here. No chart, no sparkline — this is a
 * number that reads at a glance and serves the map, per the dataviz discipline.
 */
function StatTile({
  label,
  value,
  unit,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  accent?: boolean;
}) {
  return (
    <div style={{ flex: "1 1 72px", minWidth: 72 }}>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 9,
          letterSpacing: ".1em",
          color: C.dim,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 3, marginTop: 3 }}>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 18,
            fontWeight: 600,
            lineHeight: 1,
            color: accent ? C.accent : C.text,
          }}
        >
          {value}
        </span>
        {unit && <span style={{ fontFamily: MONO, fontSize: 10, color: C.faint }}>{unit}</span>}
      </div>
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

/**
 * Historical momentum (feature 004): a rising/flat/saturating badge + an inline sparkline of the
 * monthly OSM-history series the categoryTrend tool streams on its own `data-trend` part (ADR-001).
 * The model only ever saw { direction, pctChange3y }; the ~54-point series rode straight to here.
 *
 * Honesty (constitution II): this is RELATIVE momentum measured from OSM edit history, not an
 * exhaustive absolute count, so the source line names where it came from and the badge only states
 * which way the market moved — it never claims the numbers are live or always fresh. When a trade
 * had too little history the series is empty (`enoughHistory` false) and we draw "not enough
 * history", never a fabricated flat-at-zero line (absent != 0, FR-005).
 *
 * Colour: rising takes the teal accent — a market opening up. Flat and saturating take a muted grey.
 * Never the pick yellow, which is spent once, on the #1 (see the `C.win` note).
 */
function TrendSparkline({ trend }: { trend: TrendData }) {
  const rising = trend.direction === "rising";
  const badge =
    trend.direction === "rising"
      ? "RISING"
      : trend.direction === "saturating"
        ? "SATURATING"
        : "FLAT";
  // pctChange is null when the first month's count was 0 (undividable) — then the summary just
  // carries the trade and the window, never a fabricated percentage. The window is stated as the
  // real start year ("since '22"), NOT a hardcoded "3Y": the series spans more than three years and
  // labelling it 3Y was a false claim (constitution II).
  const pct = trend.pctChange;
  const summary = [
    trend.category.replace(/_/g, " ").toUpperCase(),
    pct != null ? `${pct >= 0 ? "+" : ""}${pct}%` : null,
    `since '${String(trend.fromYear).slice(-2)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            padding: "2px 7px",
            borderRadius: 20,
            fontFamily: MONO,
            fontSize: 9.5,
            letterSpacing: ".06em",
            fontWeight: 600,
            background: rising ? "rgba(111,240,224,.14)" : "rgba(255,255,255,.07)",
            color: rising ? "#9defdf" : "#98a2ab",
          }}
        >
          {badge}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".04em", color: "#8a949d" }}>
          {summary}
        </span>
      </div>

      {trend.enoughHistory && trend.monthly.length > 1 ? (
        <Sparkline points={trend.monthly.map((m) => m.count)} rising={rising} />
      ) : (
        // absent != 0: too little history draws nothing, never a flat line pretending to be a trend.
        <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim, marginTop: 6 }}>
          not enough history
        </div>
      )}

      <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: ".06em", color: C.faint, marginTop: 4 }}>
        OSM edit history · ohsome
      </div>
    </div>
  );
}

/**
 * A bare inline sparkline. The series is plotted min→max over its own range, so a flat curve reads
 * flat and a climbing one climbs — the shape is the claim. Stretches to the rail width via a
 * viewBox; `non-scaling-stroke` keeps the line crisp under that stretch.
 */
function Sparkline({ points, rising }: { points: number[]; rising: boolean }) {
  const W = 300;
  const H = 34;
  const pad = 3;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const n = points.length;
  const coords = points.map((v, i) => {
    const x = pad + (i / (n - 1)) * (W - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (H - 2 * pad);
    return [x, y] as const;
  });
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const stroke = rising ? C.accent : "#8a949d";
  const [lx, ly] = coords[coords.length - 1];
  return (
    <svg
      width="100%"
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ display: "block", marginTop: 6, overflow: "visible" }}
    >
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* The latest month, marked. It is where the badge's direction is read from. */}
      <circle cx={lx} cy={ly} r={2.4} fill={stroke} vectorEffect="non-scaling-stroke" />
    </svg>
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
 * The dashboard is a three-column grid over the map, not a rail floating on it.
 *
 * The brief asked us to choose between split and map-dominant: the map still wins the centre and
 * gets the "well" — a bordered, inset panel it fills edge to edge — while the run stack (left) and
 * the answer/controls (right) frame it as a terminal. Every colour is a `C` palette token or a
 * chrome grey; the pick yellow `C.win` is spent only on the #1 pick, never on this chrome.
 */
const CSS = `
.wh-scroll::-webkit-scrollbar{width:7px;height:7px}
.wh-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px}
.wh-scroll::-webkit-scrollbar-track{background:transparent}
.wh-topbar{grid-column:1 / 4;display:flex;align-items:center;gap:14px;padding:0 16px;
  border-bottom:1px solid rgba(255,255,255,.07);background:rgba(9,11,14,.9)}
.wh-scrub{display:flex;align-items:center;gap:2px;padding:3px;border-radius:9px;
  background:rgba(255,255,255,.05);border:1px solid ${C.hair}}
.wh-scrub-btn{width:24px;height:22px;display:flex;align-items:center;justify-content:center;
  border-radius:6px;cursor:pointer;color:#b7c0c8;font-size:12px}
.wh-scrub-btn:hover{background:rgba(255,255,255,.06)}
.wh-topreset{width:26px;height:26px;display:flex;align-items:center;justify-content:center;
  border-radius:7px;cursor:pointer;color:#69737d;font-size:13px;border:1px solid ${C.hair}}
.wh-topreset:hover{color:#b7c0c8;border-color:rgba(255,255,255,.16)}
.wh-col-left{grid-row:2;border-right:1px solid rgba(255,255,255,.07);background:rgba(9,11,14,.72);
  display:flex;flex-direction:column;min-height:0}
.wh-col-head{padding:12px 14px 9px;display:flex;align-items:center;gap:8px;
  border-bottom:1px solid rgba(255,255,255,.05)}
.wh-runs{flex:1;min-height:0;overflow-y:auto;padding:10px 12px}
.wh-composer{border-top:1px solid rgba(255,255,255,.07);padding:11px 12px;background:rgba(7,9,12,.6)}
.wh-chip{padding:3px 8px;border-radius:20px;background:rgba(255,255,255,.04);
  border:1px solid rgba(255,255,255,.09);font-size:10px;color:#9aa4ad;cursor:pointer}
.wh-chip:hover{border-color:rgba(255,255,255,.16);color:#cdd6dd}
.wh-spin{width:9px;height:9px;border:1.5px solid #f0d878;border-top-color:transparent;
  border-radius:50%;animation:wh-run .7s linear infinite}
.wh-col-center{grid-row:2;display:flex;flex-direction:column;min-width:0;overflow:hidden;
  padding:12px;gap:12px;background:${C.bg}}
.wh-kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;height:78px;flex:none;min-width:0}
.wh-tile{padding:9px 12px;border-radius:10px;background:rgba(255,255,255,.02);
  border:1px solid rgba(255,255,255,.07);display:flex;flex-direction:column;justify-content:center;
  gap:4px;min-width:0;overflow:hidden}
.wh-tile-label{font-family:${MONO};font-size:9px;letter-spacing:.1em;color:#6b7580;text-transform:uppercase}
.wh-tile-val{display:flex;align-items:baseline;gap:4px}
.wh-tile-num{font-family:${MONO};font-size:23px;font-weight:600;color:#eef3f5;line-height:1}
.wh-tile-unit{font-size:10px;color:#7a848d}
.wh-tile-absent{font-family:${MONO};font-size:10px;color:#4c5560}
.wh-well{position:relative;flex:1;min-height:0;border-radius:14px;overflow:hidden;
  border:1px solid rgba(255,255,255,.09);
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.4),0 20px 50px -24px rgba(0,0,0,.8);background:#0a0e13}
.wh-well-pill{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:6;display:flex;
  align-items:center;gap:9px;padding:7px 15px;border-radius:20px;background:rgba(9,11,14,.86);
  backdrop-filter:blur(12px);border:1px solid ${C.hair};font-family:${MONO};font-size:11.5px;color:#cdd6dd}
.wh-caption{position:absolute;left:14px;bottom:14px;right:14px;max-width:560px;z-index:6;
  padding:13px 15px;border-radius:12px;background:rgba(9,11,14,.85);backdrop-filter:blur(14px);
  border:1px solid rgba(111,240,224,.18);box-shadow:0 18px 40px -20px rgba(0,0,0,.8)}
.wh-legend{position:absolute;right:14px;top:14px;z-index:6;display:flex;flex-direction:column;gap:6px;
  padding:9px 11px;border-radius:10px;background:rgba(9,11,14,.72);backdrop-filter:blur(10px);
  border:1px solid ${C.hair};font-family:${MONO};font-size:9.5px}
.wh-legend-row{display:flex;align-items:center;gap:7px}
.wh-col-right{grid-row:2;border-left:1px solid rgba(255,255,255,.07);background:rgba(9,11,14,.72);
  overflow-y:auto;padding:14px 14px 18px;display:flex;flex-direction:column;gap:16px;min-height:0}
.wh-dot{width:7px;height:7px;border-radius:50%;background:${C.accent};animation:wh-pulse 1s infinite}
.wh-pop{position:absolute;left:318px;top:150px;z-index:20;width:266px;padding:15px;border-radius:13px;
  background:rgba(9,11,14,.94);backdrop-filter:blur(14px);box-shadow:0 24px 60px -20px rgba(0,0,0,.8)}
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
.wh-save{flex:none;padding:5px 9px;border-radius:7px;background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.12);color:#cdd6dd;font-family:${MONO};font-size:10px;cursor:pointer}
.wh-save:disabled{cursor:default}
.wh-save-done{background:rgba(111,240,224,.12);border-color:rgba(111,240,224,.35);color:#9defdf}
.wh-saved-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.wh-compare{width:100%;margin-top:10px;padding:9px;border-radius:9px;background:rgba(111,240,224,.1);
  border:1px solid rgba(111,240,224,.28);color:#9defdf;font-family:${SANS};font-size:12.5px;
  font-weight:500;cursor:pointer}
.wh-compare:disabled{opacity:.4;cursor:default}
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
@keyframes wh-run{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){
  .wh-marker,.wh-dot,.wh-ring,.wh-caret,.wh-spin{animation:none!important;transition:none!important}
}
`;
