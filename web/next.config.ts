import type { NextConfig } from "next";

// Day 5 / ADR-003: the app ships as a static bundle, loaded into ClickHouse row-by-row
// (`infra/deploy-app.sh`) and served through the Cloudflare Worker in `infra/app-worker/`.
// `next build` must produce `out/` with zero server runtime — no Server Actions, no API
// routes, no Image Optimization server (there is no `next/image` usage in this app, so
// `images.unoptimized` isn't load-bearing, but it's the documented pairing for `export`).
//
// `next dev` is unaffected by `output: "export"` — it only changes what `next build`
// produces, so local dev (`pnpm dev` + `pnpm exec trigger dev`) keeps working exactly as
// before.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
