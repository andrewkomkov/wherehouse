import React from "react";
import { Composition } from "remotion";
import { Demo, type Timings, type Zoom } from "./Video";
import timingsJson from "./timings.json";
import beatsJson from "./beats.json";

/**
 * Duration and captions come from `timings.json`, which the pipeline overwrites with the REAL
 * per-beat offsets the Playwright capture measured (video/build.sh copies out/timings.json here).
 * The committed default lets `remotion studio` open before anything is captured.
 *
 * The per-beat Ken-Burns `zoom` spec lives in `beats.json` (the single source of truth the
 * capture and render both read — never hard-code it here). It's merged onto the measured
 * timings by beat `id` so Video.tsx only has one shape to deal with.
 */
const zoomById = new Map<string, Zoom>(
  (beatsJson.beats as { id: string; zoom?: Zoom }[])
    .filter((b): b is { id: string; zoom: Zoom } => !!b.zoom)
    .map((b) => [b.id, b.zoom]),
);
// Per-beat caption placement, also read from beats.json (never hard-coded here). Default is the
// bottom lower-third; a beat whose focal subject sits in the lower map (e.g. `pick`, which glows
// the top hex) sets "top" so the band never lands on it.
const captionAtById = new Map<string, "top" | "bottom">(
  (beatsJson.beats as { id: string; captionAt?: "top" | "bottom" }[])
    .filter((b): b is { id: string; captionAt: "top" | "bottom" } => !!b.captionAt)
    .map((b) => [b.id, b.captionAt]),
);
const timings: Timings = {
  ...timingsJson,
  // timings.json's `source` field is a plain string as far as JSON type inference goes —
  // capture.mjs (buildTimeline()) is the actual guarantee it's only ever "app" or "console".
  beats: timingsJson.beats.map((b) => ({
    ...b,
    source: b.source as "app" | "console" | undefined,
    zoom: zoomById.get(b.id),
    captionAt: captionAtById.get(b.id),
  })),
};
const FPS = timings.fps || 30;
const durationInFrames = Math.max(1, Math.round((timings.totalMs / 1000) * FPS));

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Demo"
    component={Demo}
    durationInFrames={durationInFrames}
    fps={FPS}
    width={1920}
    height={1080}
    defaultProps={{ timings }}
  />
);
