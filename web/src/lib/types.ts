/**
 * Shared, client-safe types for the OLTP-backed saved-site history.
 *
 * Pulled out of `lib/pg.ts` on day 5: that module imports `pg` + `node:fs` (reads the
 * Postgres CA off disk) and must never enter the client bundle. `chat.tsx` used to import
 * `SavedSiteRow` from `@/lib/pg` as a type-only import, which is normally erased at compile
 * time — but with the static export (`output: "export"`) there is no server runtime at all
 * to fall back on if that erasure ever doesn't happen, so the type now lives here, with zero
 * dependencies, and both the client and the Worker's server-side code import from here.
 */
export type SavedSiteRow = {
  id: number;
  shortlist_id: number;
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
