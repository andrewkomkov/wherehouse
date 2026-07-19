import React from "react";
import {
  AbsoluteFill,
  Easing,
  OffthreadVideo,
  Sequence,
  staticFile,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Caption, BrandBug } from "./Captions";

/** A per-beat Ken-Burns spec, read from beats.json (never hard-coded — see Root.tsx). fx/fy are
 * the normalized focus point (0..1 across the 1920x1080 output frame); s0 -> s1 is the slow
 * intra-beat scale drift. Capped at 2.0x (video is a 4K master shown at 1080p — 2.0x is native
 * 1:1 pixels; anything past that would upscale and blur). */
export type Zoom = { fx: number; fy: number; s0: number; s1: number };

export type Timings = {
  fps: number;
  totalMs: number;
  beats: {
    id: string;
    caption: string;
    startMs: number;
    endMs: number;
    /** Which recorded file this beat's footage plays from — "app" for the continuous
     * WhereHouse capture, "console" for the separate ClickHouse /play recording (inserted
     * on the timeline, but never part of the app's own recording — see capture.mjs). */
    source?: "app" | "console";
    /** Offset within that SOURCE file where this beat's footage begins — distinct from
     * `startMs`, which is the beat's position on the OUTPUT timeline. For app beats these
     * coincide minus whatever console footage has been inserted earlier on the timeline;
     * for the console beat this is always 0. */
    sourceInMs?: number;
    zoom?: Zoom;
    /** Where this beat's lower-third caption sits — "bottom" (default) or "top", for beats whose
     * focal subject sits in the lower map and would collide with the bottom band. */
    captionAt?: "top" | "bottom";
  }[];
};

// The pipeline places both captured recordings in public/ — the continuous WhereHouse
// capture, and the separate ClickHouse /play console recording inserted between beats.
const APP_FOOTAGE = "screen.mp4";
const CONSOLE_FOOTAGE = "console.mp4";

const MAX_ZOOM = 2.0;
const DEFAULT_ZOOM: Zoom = { fx: 0.5, fy: 0.52, s0: 1, s1: 1 };
// How long the camera takes to glide its focus point from the previous beat's to the current
// beat's, at each beat boundary — a camera pan, not a cut.
const GLIDE_MS = 700;
const ease = Easing.inOut(Easing.ease);

/**
 * The Ken-Burns rig: at a given wall-clock ms, find which beat we're in (clamping to the first/
 * last beat outside the beat range — the lead-in and the tail hold) and return the transform-
 * origin focus point and scale for that instant.
 *
 * - Scale eases from the beat's s0 to s1 across the WHOLE beat (a slow push/pull), hard-capped at
 *   MAX_ZOOM regardless of what's configured.
 * - The focus point eases from the PREVIOUS beat's (fx,fy) to the CURRENT beat's over the first
 *   GLIDE_MS of the beat, then holds — so the camera glides into position at each cut instead of
 *   snapping, and continues drifting/pushing in on the new subject for the rest of the beat.
 */
function kenBurns(ms: number, beats: Timings["beats"]): { fx: number; fy: number; s: number } {
  if (beats.length === 0) return { fx: DEFAULT_ZOOM.fx, fy: DEFAULT_ZOOM.fy, s: 1 };

  let idx = beats.findIndex((b) => ms >= b.startMs && ms < b.endMs);
  if (idx === -1) idx = ms < beats[0].startMs ? 0 : beats.length - 1;

  const beat = beats[idx];
  const zoom = beat.zoom ?? DEFAULT_ZOOM;
  const prevZoom = idx > 0 ? beats[idx - 1].zoom ?? DEFAULT_ZOOM : zoom;

  const beatDur = Math.max(1, beat.endMs - beat.startMs);
  const beatT = Math.min(1, Math.max(0, (ms - beat.startMs) / beatDur));
  const scaleT = ease(beatT);
  const s = Math.min(MAX_ZOOM, zoom.s0 + (zoom.s1 - zoom.s0) * scaleT);

  const glideT = Math.min(1, Math.max(0, (ms - beat.startMs) / GLIDE_MS));
  const focusT = ease(glideT);
  const fx = prevZoom.fx + (zoom.fx - prevZoom.fx) * focusT;
  const fy = prevZoom.fy + (zoom.fy - prevZoom.fy) * focusT;

  return { fx, fy, s };
}

/**
 * The demo composition: the real screen recording, full-frame, with synced lower-third captions
 * and a corner wordmark. A short fade-in/out top-and-tails it. This render is intentionally
 * SILENT — the English voiceover and soundtrack are generated and muxed on afterward by
 * video/voiceover/mix.py (no re-render). The captions carry the message on their own.
 */
export const Demo: React.FC<{ timings: Timings }> = ({ timings }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const ms2f = (ms: number) => Math.round((ms / 1000) * fps);

  const fade = interpolate(
    frame,
    [0, 12, durationInFrames - 16, durationInFrames - 1],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // Ken-Burns: a slow, gliding camera over the 4K master. Never a hard cut, never past 2.0x.
  const { fx, fy, s } = kenBurns((frame / fps) * 1000, timings.beats);

  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0c0f" }}>
      {/* Fallback backdrop so a missing/black frame of footage still reads as intentional. */}
      <AbsoluteFill
        style={{
          background: "radial-gradient(120% 90% at 50% 6%, #0d1015 0%, #0a0c0f 60%, #070809 100%)",
        }}
      />

      {/* One Sequence per beat: its OWN source video (the continuous app capture, or the
          separately-recorded ClickHouse /play console, inserted on the timeline — see
          buildTimeline() in capture.mjs) at its OWN offset into that file, plus its caption.
          The Ken-Burns transform (fx/fy/s, computed above from the GLOBAL timeline position)
          is shared across beats — only one Sequence is ever mounted/visible at a given frame,
          so this reads as one continuous camera move even though the footage underneath cuts
          from file to file. */}
      {timings.beats.map((b) => {
        const from = ms2f(b.startMs);
        const dur = Math.max(1, ms2f(b.endMs) - from);
        const src = b.source === "console" ? CONSOLE_FOOTAGE : APP_FOOTAGE;
        const startFrom = ms2f(b.sourceInMs ?? b.startMs);
        return (
          <Sequence key={b.id} from={from} durationInFrames={dur} name={b.id}>
            <AbsoluteFill style={{ opacity: fade, overflow: "hidden" }}>
              <OffthreadVideo
                src={staticFile(src)}
                startFrom={startFrom}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  transformOrigin: `${fx * 100}% ${fy * 100}%`,
                  transform: `scale(${s})`,
                }}
                // If the capture is shorter/longer than the beat window, hold the last frame
                // rather than cutting to black.
                pauseWhenBuffering
              />
            </AbsoluteFill>
            {/* Sibling of the (transformed) video, not a child of it — so the caption stays
                at OUTPUT resolution and never moves or scales with the zoomed footage. */}
            <Caption text={b.caption} durationInFrames={dur} atTop={b.captionAt === "top"} />
          </Sequence>
        );
      })}

      <AbsoluteFill style={{ opacity: fade }}>
        <BrandBug />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
