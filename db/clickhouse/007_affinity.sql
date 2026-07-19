-- Complementary-business affinity. The table that lets the agent say "this cell already has the
-- hair salons and galleries a cafe feeds off" — a colour on the map, never a number in the rank.
--
-- ⚠️ THESE WEIGHTS ARE AN EDITORIAL HEURISTIC, NOT A MEASUREMENT.
--
-- `weight` is a hand-authored guess at how much a neighbouring trade complements the target one.
-- Nothing measured it. It is not a correlation, not a lift, not a footfall study — it is opinion,
-- pinned here so the opinion is at least explicit, reviewable and in one place instead of scattered
-- through prose. Treat it exactly as you would treat a sentence someone wrote: it can be wrong.
--
-- Because it is editorial it MUST stay out of the measured GAP ranking. GAP is
-- demand × (100 − supply) × accessibility and stays that way. Affinity is a SEPARATE, LABELLED
-- "neighbourhood fit" signal shown next to the answer, never multiplied into the score that orders
-- the picks. If it ever enters the rank, an opinion has been laundered into a measurement — the
-- precise failure constitution II names.
--
-- THE ABSENT-IS-NOT-ZERO CONTRACT
-- A pick whose k-ring holds none of the complementary trades has fit 0 here only because
-- dictGetFloat32 returns 0 on a miss. That 0 means "we found no complementary trades nearby",
-- which the UI must render as those words — never as a measured "fit = 0" fact. Absent ≠ zero.
--
-- HOW IT IS USED
-- The category the user asks about maps to a `target` via CATEGORY_SYNONYMS in
-- web/src/trigger/chat.ts (e.g. "coffee" → cafe). A group like "food and drink" has no single
-- target, so the fit calc falls back to the 'restaurant' weights. Per-cell neighbourhood fit is
--     sum(dictGetFloat32('geo.affinity_dict','weight',(target, category)))
--     over arrayJoin(h3kRing(h3_8, 1)) of the city's places
-- i.e. every complementary place within one H3 ring of the candidate cell, weighted.
--
-- WHAT WAS VERIFIED, 2026-07-17, against the live service (Cloud 26.4) — not against docs
--   * A COMPLEX_KEY_HASHED dictionary keyed (target, neighbor) works on 26.4;
--     dictGetFloat32('geo.affinity_dict','weight',('cafe','hair_salon')) = 0.9, a miss returns 0.
--   * Every `neighbor` string below exists in geo.places.category with a nonzero count. Neighbours
--     that Overture does not carry were to be dropped, not invented — none had to be.
--   * The per-cell fit query above runs sub-second over Berlin and ranks cells sensibly.
--
-- Load with infra/load-affinity.sh (it applies this file, then verifies the dict answers and that
-- a sample per-cell fit is > 0). The table is tiny and fully specified here, so the loader
-- recreates and refills it rather than patching — DROP + CREATE is the idempotency story.

CREATE DATABASE IF NOT EXISTS geo;

-- Drop the dictionary before the table it sources from, else the DROP TABLE is refused.
DROP DICTIONARY IF EXISTS geo.affinity_dict;
DROP TABLE IF EXISTS geo.affinity;

CREATE TABLE geo.affinity
(
    -- The trade being placed. Matches a `target` produced from the user's category via
    -- CATEGORY_SYNONYMS in web/src/trigger/chat.ts.
    target   String,
    -- A complementary trade that, when already nearby, makes `target` a better fit. Every value
    -- here is a real geo.places.category string, verified present against the live service.
    neighbor String,
    -- EDITORIAL weight, 0..1. Hand-authored opinion of complementarity strength. Not measured.
    weight   Float32
)
ENGINE = MergeTree
-- Tiny and fully specified in this file, so reloading is DROP + CREATE, not a partition dance.
ORDER BY (target, neighbor);

-- The editorial matrix. target ← neighbor : weight. Opinion, not measurement (see header).
INSERT INTO geo.affinity (target, neighbor, weight) VALUES
    ('bakery', 'elementary_school', 0.8),
    ('bakery', 'kindergarten', 0.8),
    ('bakery', 'supermarket', 0.6),
    ('bakery', 'cafe', 0.5),
    ('bakery', 'coffee_shop', 0.5),
    ('bakery', 'park', 0.5),
    ('bakery', 'pharmacy', 0.4),
    ('cafe', 'art_gallery', 1.0),
    ('cafe', 'hair_salon', 0.9),
    ('cafe', 'beauty_salon', 0.8),
    ('cafe', 'gym', 0.8),
    ('cafe', 'hotel', 0.7),
    ('cafe', 'park', 0.7),
    ('cafe', 'clothing_store', 0.6),
    ('cafe', 'bar', 0.4),
    -- coffee_shop shares cafe's profile: the two are one trade split by Overture's taxonomy.
    ('coffee_shop', 'art_gallery', 1.0),
    ('coffee_shop', 'hair_salon', 0.9),
    ('coffee_shop', 'beauty_salon', 0.8),
    ('coffee_shop', 'gym', 0.8),
    ('coffee_shop', 'hotel', 0.7),
    ('coffee_shop', 'park', 0.7),
    ('coffee_shop', 'clothing_store', 0.6),
    ('coffee_shop', 'bar', 0.4),
    ('pharmacy', 'doctor', 1.0),
    ('pharmacy', 'dentist', 0.9),
    ('pharmacy', 'physical_therapy', 0.8),
    ('pharmacy', 'supermarket', 0.6),
    ('pharmacy', 'elementary_school', 0.4),
    ('restaurant', 'hotel', 0.9),
    ('restaurant', 'bar', 0.8),
    ('restaurant', 'landmark_and_historical_building', 0.7),
    ('restaurant', 'art_gallery', 0.6),
    ('supermarket', 'pharmacy', 0.6),
    ('supermarket', 'bakery', 0.5),
    ('supermarket', 'gas_station', 0.5),
    ('supermarket', 'bank_credit_union', 0.4),
    ('gym', 'sports_club_and_league', 0.9),
    ('gym', 'physical_therapy', 0.9),
    ('gym', 'beauty_salon', 0.7),
    ('gym', 'cafe', 0.5),
    ('gym', 'coffee_shop', 0.5),
    ('kindergarten', 'elementary_school', 0.9),
    ('kindergarten', 'park', 0.8),
    ('kindergarten', 'pharmacy', 0.5),
    ('kindergarten', 'bakery', 0.5),
    -- dentist: a health-cluster destination — patients and referrals flow between medical trades.
    ('dentist', 'doctor', 0.9),
    ('dentist', 'pharmacy', 0.8),
    ('dentist', 'physical_therapy', 0.6),
    ('dentist', 'beauty_salon', 0.3),
    ('dentist', 'supermarket', 0.3),
    -- hair_salon: a beauty/high-street trade — footfall shared with grooming and shopping.
    ('hair_salon', 'beauty_salon', 0.7),
    ('hair_salon', 'nail_salon', 0.7),
    ('hair_salon', 'clothing_store', 0.6),
    ('hair_salon', 'cafe', 0.5),
    ('hair_salon', 'coffee_shop', 0.5),
    ('hair_salon', 'gym', 0.4),
    -- hotel: hospitality — guests spend on dining, nightlife and nearby attractions.
    ('hotel', 'landmark_and_historical_building', 0.9),
    ('hotel', 'restaurant', 0.8),
    ('hotel', 'bar', 0.7),
    ('hotel', 'cafe', 0.6),
    ('hotel', 'coffee_shop', 0.6);

-- Keyed on (target, neighbor); a miss returns 0 (the absent-is-not-zero contract lives in the
-- consumer, which must read a 0 as "no complementary trades nearby", never as a measured fit).
CREATE OR REPLACE DICTIONARY geo.affinity_dict
(
    target   String,
    neighbor String,
    weight   Float32
)
PRIMARY KEY target, neighbor
SOURCE(CLICKHOUSE(TABLE 'affinity' DB 'geo'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(MIN 0 MAX 3600);
