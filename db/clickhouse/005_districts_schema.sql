-- Place names. The table that lets the agent say "Lichtenrade" instead of making one up.
--
-- WHY THIS EXISTS — read this before touching anything below.
--
-- On the first live run of day 3 the model was asked where to open a bakery in Berlin. The
-- map was right. The sentence put all three picks in **Spandau** — the opposite side of the
-- city. Nothing had lied to it: `rankSites` returned gap/population/competitor counts and no
-- place names at all, so when the answer wanted a name, the model produced a plausible one.
-- We banned naming districts in the system prompt as a stopgap, which made the answer worse
-- ("an underserved area" is a weaker demo line than "Lichtenrade") to make it honest.
--
-- Then the identical defect was found in our own spec: "Mariendorf, Hellersdorf, Köpenick"
-- had been eyeballed off coordinates and written down as measured fact. All three were wrong
-- (truth: Lichtenrade, Biesdorf, Mahlsdorf). It survived review because the reference SQL
-- returned no names — nothing anyone could run would contradict it. That is constitution II's
-- "unfalsifiable claim is the dangerous kind", and this table is the falsifier.
--
-- So: a name in the answer now comes from a point-in-polygon test against real geometry, or
-- it does not appear. There is no third option, and in particular there is no nearest-guess.
--
-- Source: Overture `theme=divisions/type=division_area`, release 2026-06-17.0, on public S3.
-- Overture divisions derive from OSM (ODbL). Attribution is in web/src/components/attribution.tsx.
--
-- ---------------------------------------------------------------------------------------
-- WHY THE COLUMNS ARE CALLED `area` AND `locality` AND NOT `ortsteil` / `bezirk`
-- ---------------------------------------------------------------------------------------
-- The first cut of this table used the German terms, because Berlin is the primary demo and in
-- Berlin the mapping is exact: macrohood = Ortsteil (Lichtenrade), locality = Bezirk
-- (Tempelhof-Schöneberg). That was the same bug this table exists to fix, one level up: it took
-- something true of Berlin and encoded it in the schema as if it were true everywhere.
--
-- It is not. Measured: `subtype='locality'` returns the Serbian village **Ковилово** and the
-- Dutch town **Spaarndam** — calling either a "Bezirk" is nonsense. And Berlin's own bbox holds
-- **97 distinct localities** where the city has 12 Bezirke, because the box reaches into
-- Brandenburg and every town out there is a locality too.
--
-- So the columns are named after what Overture actually means, which is true in all three cities:
--   * `locality` — Overture's own subtype name: a named settlement or borough. A Bezirk inside
--                  Berlin, a Gemeinde in Brandenburg, a municipality in NL, a village in RS.
--   * `area`     — deliberately generic: a named part of a locality (Overture `macrohood`).
--                  Berlin Ortsteil, Amsterdam stadsdeel. No equivalent in most of Belgrade.
-- If either name ever needs to become more specific, that specificity has to be measured in all
-- three cities first.
--
-- ---------------------------------------------------------------------------------------
-- WHAT WAS VERIFIED, 2026-07-20, against the live service (26.4.1.2029) — not against docs
-- ---------------------------------------------------------------------------------------
--
-- * ⚠️ **`readWKB(geometry)` is WRONG here and fails with ILLEGAL_TYPE_OF_ARGUMENT.** Overture's
--   `geometry` column already arrives from `s3()` as a native `Geometry` type, which is a
--   Variant. Unwrap it instead:
--       variantType(geometry)                      -- 'Polygon' | 'MultiPolygon'
--       variantElement(geometry, 'Polygon')        -- for pointInPolygon
--       variantElement(geometry, 'MultiPolygon')   -- an Array of Polygons; arrayExists over it
--   Around Berlin both variants occur, so handling only 'Polygon' silently drops districts.
--
-- * **MEASURED COVERAGE, 2026-07-20 — % of populated H3 res-8 cells that got each name.**
--   Do not rediscover this; it is a property of Overture, not a bug in the loader:
--
--       city        populated cells    locality      area
--       berlin              2,260        98.3%     56.8%
--       amsterdam             739       100.0%     47.8%
--       belgrade            1,076       100.0%      3.9%     <-- area is effectively EMPTY here
--
--   **Zero cells in any city have no name at all** — every populated cell gets at least a
--   locality. But `area` is thin by design of the source: Overture has 119 macrohoods around
--   Berlin, 9 around Amsterdam and **3** around Belgrade. So *locality-only is the normal case
--   in Belgrade*, not a degraded one, and every consumer must read naturally without an `area`.
--   Berlin's 56.8% is the same story from the other end: its bbox reaches into Brandenburg,
--   where the Ortsteil tier simply stops.
--
--   Do NOT "fix" Belgrade's coverage by falling back to `neighborhood`/`microhood`: they are a
--   different tier, and quietly relabelling a neighbourhood as an `area` would reintroduce
--   exactly the confident-but-wrong naming this table exists to kill.
--
-- * **Names are Overture's `names.common['en']` when it exists, else `names.primary`.** This is
--   a measured no-op everywhere except Belgrade, which is the whole reason for it:
--
--       city        divisions   have 'en'   'en' DIFFERS from primary
--       berlin            233           0           0      <-- cannot affect Lichtenrade
--       amsterdam          56           2           0
--       belgrade           56          56          56      <-- Обреновац -> Obrenovac
--
--   So Belgrade renders Latin (Zvezdara, Vozdovac, Belgrade) on an English-language demo for an
--   international jury, and Berlin/Amsterdam are provably untouched. Note this is READING a
--   field Overture ships, not transliterating ourselves — the name still comes from the data.
--   If you want Cyrillic back, drop the coalesce in infra/load-districts.sh; nothing else cares.
--
-- * **`locality` polygons nest, so a point can be inside more than one.** Measured over Berlin's
--   2,260 populated cells: 1,634 matched exactly one locality, 574 matched two, 13 matched three
--   (e.g. Blankenfelde ⊂ Blankenfelde-Mahlow; Wilmersdorf ⊂ Werneuchen — note that is
--   Brandenburg's Wilmersdorf, not Berlin's, which is precisely the sort of trap that makes
--   eyeballing names fatal). The loader resolves this with **smallest containing polygon wins**,
--   which is deterministic and is the standard most-specific-match rule. Verified by area:
--   Blankenfelde 12.28 km2 ⊂ Blankenfelde-Mahlow 54.95 km2. `macrohood` did not overlap at all
--   (1,283 hits across 1,283 cells), so the rule is a no-op there — but it is applied to both
--   tiers anyway, because "it happens not to overlap today" is not a guarantee.
--
--   ⚠️ `polygonAreaSpherical` returns **steradians**, and its sign follows ring winding — always
--   `abs(...) * 6371007.18^2` for m2. Only the ORDER matters here, but the abs() does not.
--
-- * **Ground truth, asserted by infra/load-districts.sh verify.** These three cells are the
--   day-3 picks and they MUST resolve to these names. A loader that reports success while these
--   are wrong is the exact failure mode this table exists to prevent, so the check is not
--   optional and must not be downgraded to a warning:
--
--       881f18b021fffff  (13.40054, 52.40435)  Lichtenrade  Tempelhof-Schöneberg
--       881f1d4d81fffff  (13.55321, 52.49992)  Biesdorf     Marzahn-Hellersdorf
--       881f18b645fffff  (13.61426, 52.49862)  Mahlsdorf    Marzahn-Hellersdorf
--
-- ---------------------------------------------------------------------------------------
-- THE EMPTY-STRING CONTRACT
-- ---------------------------------------------------------------------------------------
-- A name we do not have is `''`, never a placeholder, never the nearest district. Every
-- consumer must treat `''` as "no name" and omit it from prose and from the popup. The columns
-- are String rather than Nullable(String) because the loader builds them with argMinIf, which
-- yields '' for a tier that matched nothing — one representation, checked in one place
-- (placeName() in web/src/trigger/chat.ts).
--
-- Given Belgrade's 3.9%, the `area = ''` path is the COMMON path, not an edge case. It is
-- exercised by the demo, not just by tests.
--
-- Load with infra/load-districts.sh (it applies this file, then verifies the three cells above).

CREATE DATABASE IF NOT EXISTS geo;

-- "districts" is used here in its generic English sense — a named area — NOT as a translation of
-- Bezirk. See the naming note above before adding anything jurisdiction-specific to this table.
CREATE TABLE IF NOT EXISTS geo.districts
(
    -- Kontur's cell id, verbatim from geo.population. NOT recomputed from lat/lon here: the
    -- whole H3 family is lat-first while every other geo function is lon-first, and getting it
    -- backwards is silent (plausible counts, hexes in the Indian Ocean). This table consumes an
    -- h3_8 that geo.population already holds, so there is no geoToH3 call to get wrong.
    h3_8     UInt64,

    -- The fine name (Overture `macrohood`): Berlin Ortsteil, Amsterdam stadsdeel. '' when
    -- Overture has no macrohood covering the cell — 43% of Berlin's box, and 96% of Belgrade.
    area     String,

    -- The coarse name (Overture `locality`): a named settlement or borough. Berlin Bezirk,
    -- Brandenburg Gemeinde, Dutch municipality, Serbian village. Effectively always present
    -- (98-100%), but '' is still legal and must still be handled.
    locality String,

    -- berlin | amsterdam | belgrade
    city     LowCardinality(String)
)
ENGINE = MergeTree
-- Reloading one city is a DROP PARTITION, not a rebuild. ~4k rows total across three cities,
-- so this is about the loader staying idempotent, not about performance.
PARTITION BY city
-- The join predicate in rankSql is `districts.h3_8 = scored.cell`, and geo.population /
-- geo.places are sorted the same way — so the lookup is an equality probe on the sort key with
-- no runtime geometry anywhere near the request path. All the pointInPolygon work happens here,
-- once, at load time.
ORDER BY h3_8;
