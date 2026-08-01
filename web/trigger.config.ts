import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_klnembmmwmnxxishtmvf",
  // node-22, not the default "node" (Node 21): `refresh-population` reads the Kontur GeoPackage
  // with `node:sqlite`, which is built in from Node 22.5 only. On the default runtime the task
  // failed 4 s in with "No such built-in module: node:sqlite" — its first ever scheduled run,
  // 2026-08-01 05:00 UTC. The dynamic `await import("node:sqlite")` in refresh-loaders.ts was
  // added to keep the DEPLOY-time indexer (an older Node) working; it never made the module
  // exist at run time, which is what this setting does. Allowed values, checked in the SDK's own
  // schema rather than assumed: ["node", "node-22", "bun"].
  runtime: "node-22",
  logLevel: "log",
  maxDuration: 300,
  dirs: ["./src/trigger"],
});
