import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

const TEAL = "#6ff0e0";

/**
 * One lower-third caption. Rendered inside a <Sequence> so `frame` is 0 at the caption's start.
 * Springs up + fades in over the first ~0.5s, holds, fades out over the last ~0.5s. Positioned
 * bottom-centre with a translucent slab so it reads over any part of the app UI beneath it.
 */
export const Caption: React.FC<{ text: string; durationInFrames: number; atTop?: boolean }> = ({
  text,
  durationInFrames,
  atTop = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200, mass: 0.7 } });
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 14, durationInFrames - 2],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const opacity = Math.min(enter, fadeOut);
  // Spring the band in from the direction it lives: down-from-above at top, up-from-below at bottom.
  const y = interpolate(enter, [0, 1], [atTop ? -26 : 26, 0]);

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        // Default: raised clear of the app's own bottom-left answer caption + provenance chips,
        // floating over the lower map. `atTop` instead pins it below the brand bug — for beats
        // (e.g. `pick`) whose glowing focal hex sits in the lower map and the bottom band would
        // land on it.
        ...(atTop ? { top: 118 } : { bottom: 232 }),
        display: "flex",
        justifyContent: "center",
        opacity,
        transform: `translateY(${y}px)`,
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          padding: "18px 30px",
          borderRadius: 16,
          background: "rgba(9,11,14,0.82)",
          backdropFilter: "blur(10px)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 24px 70px -24px rgba(0,0,0,0.85)",
          display: "flex",
          alignItems: "center",
          gap: 18,
        }}
      >
        <span
          style={{
            flex: "none",
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: TEAL,
            boxShadow: `0 0 16px ${TEAL}`,
          }}
        />
        <span
          style={{
            fontFamily:
              "'IBM Plex Sans', -apple-system, system-ui, sans-serif",
            fontSize: 40,
            fontWeight: 500,
            letterSpacing: "-0.01em",
            lineHeight: 1.15,
            color: "#eef3f6",
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
};

/** The persistent corner wordmark — small, so it never competes with the app. */
export const BrandBug: React.FC = () => (
  <div
    style={{
      position: "absolute",
      top: 30,
      right: 34,
      display: "flex",
      alignItems: "center",
      gap: 9,
      opacity: 0.9,
      fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
    }}
  >
    <div
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        background: "#FAFF69",
        display: "grid",
        placeItems: "center",
      }}
    >
      <div style={{ width: 8, height: 8, borderRadius: "50%", border: "2.5px solid #0a0c0f" }} />
    </div>
    <span style={{ fontSize: 20, fontWeight: 700, color: "#e7ecf0", letterSpacing: "-0.01em" }}>
      WhereHouse
    </span>
  </div>
);
