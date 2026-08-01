/**
 * Shared, client-safe types for the saved-site history.
 *
 * Pulled out of `lib/pg.ts` on day 5, when that module still imported `pg` + `node:fs` (it read
 * the Postgres CA off disk) and had to be kept out of the client bundle. The module itself is
 * gone with ADR-005 — saved sites live in ClickHouse now — but the type stays here, dependency
 * free, shared by the client and the Worker.
 */
/**
 * The p95 scalars ClickHouse used to normalise demand/supply/accessibility for one query.
 *
 * The single source of truth: the server (`trigger/layers.ts`, on the `opportunity` map part) and
 * the browser (`components/score.ts`, re-deriving the score for the sliders) both need this shape,
 * and neither may import the other's module — layers.ts pulls in `@clickhouse/client` and the
 * Trigger SDK, score.ts pulls in `maplibre-gl`, and this file must stay dependency-free so the
 * client bundle never drags in either. It lived verbatim in both; defined once here so a factor
 * added to one side cannot silently disagree with the other.
 */
export type Scale = { popP95: number; supP95: number; accP95: number };

export type SavedSiteRow = {
  /** UUID — ClickHouse has no sequences; see db/clickhouse/014_saved_sites.sql. */
  id: string;
  label: string;
  lon: number;
  lat: number;
  h3_8: string;
  /** null when never scored — the panel shows "unscored", not 0. */
  score: number | null;
  status: string;
  city: string;
  business_type: string;
  created_at: string;
};
