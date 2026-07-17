-- Load geo.places from Overture Maps parquet on public S3. No credentials, no local copy.
-- Requires 001_places_schema.sql.
--
-- Idempotent per city: DROP PARTITION then INSERT. Re-running a city is safe.
--
-- ⚠️ The release rotates — 2026-06-17.0 was current on 2026-07-17. Enumerate, don't trust:
--   curl -s "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&delimiter=/&prefix=release/" \
--     | grep -o '<Prefix>release/[^<]*</Prefix>' | sed 's/<[^>]*>//g'
--
-- ⚠️ Filter on bbox.*, NEVER on geometry. bbox is plain floats, so parquet row-group
--    stats prune nearly everything; a predicate on geometry forces a full point decode.
--
-- ⚠️ bbox is NOT a degenerate point, even though every place IS one. Verified 2026-07-17:
--    Overture stores bbox at float32 precision while geometry is float64, so a point gets
--    a ~1 m envelope with xmin != xmax. A bbox predicate is therefore approximate at the
--    boundary: 'JSV Bernau e. V.' has bbox.ymin 52.67499923 (passes `<= 52.675`) but true
--    geometry.2 52.67500629 (outside it), and lands in the table ~1 m past the edge.
--    Harmless here — these are hand-drawn metro bboxes, not legal boundaries — but do not
--    build an exact point-in-region claim on a bbox filter. Use pointInPolygon on lon/lat
--    for that, after bbox has done the cheap pruning.
--
-- Measured 2026-07-17 (service eu-west-1, bucket us-west-2), cold:
--   berlin 5.8 s / 139807 rows · amsterdam 2.1 s / 45988 · belgrade 1.7 s / 26023
--   11.5 MiB on disk total, 1 part per city.

---------------------------------------------------------------------------------
-- Berlin
---------------------------------------------------------------------------------
ALTER TABLE geo.places DROP PARTITION 'berlin';

INSERT INTO geo.places (id, name, category, confidence, lon, lat, city)
SELECT
    id,
    coalesce(names.primary, '')          AS name,
    coalesce(categories.primary, '')     AS category,
    toFloat32(coalesce(confidence, 0.))  AS confidence,
    geometry.1                           AS lon,  -- Overture geometry.1 is LON
    geometry.2                           AS lat,  -- Overture geometry.2 is LAT
    'berlin'                             AS city
FROM s3('https://overturemaps-us-west-2.s3.amazonaws.com/release/2026-06-17.0/theme=places/type=place/*.parquet', 'Parquet')
WHERE bbox.xmin BETWEEN 13.088 AND 13.761
  AND bbox.ymin BETWEEN 52.338 AND 52.675
  -- confidence is a real quality signal, not decoration: it strips junk geocodes
  -- (Overture parks some at the space-filling-curve origin). Drops 13.2% of Berlin.
  AND coalesce(confidence, 0.) >= 0.5
  AND coalesce(operating_status, 'open') != 'closed';

---------------------------------------------------------------------------------
-- Amsterdam
---------------------------------------------------------------------------------
ALTER TABLE geo.places DROP PARTITION 'amsterdam';

INSERT INTO geo.places (id, name, category, confidence, lon, lat, city)
SELECT
    id,
    coalesce(names.primary, '')          AS name,
    coalesce(categories.primary, '')     AS category,
    toFloat32(coalesce(confidence, 0.))  AS confidence,
    geometry.1                           AS lon,
    geometry.2                           AS lat,
    'amsterdam'                          AS city
FROM s3('https://overturemaps-us-west-2.s3.amazonaws.com/release/2026-06-17.0/theme=places/type=place/*.parquet', 'Parquet')
WHERE bbox.xmin BETWEEN 4.680 AND 5.070
  AND bbox.ymin BETWEEN 52.270 AND 52.440
  AND coalesce(confidence, 0.) >= 0.5
  AND coalesce(operating_status, 'open') != 'closed';

---------------------------------------------------------------------------------
-- Belgrade
---------------------------------------------------------------------------------
ALTER TABLE geo.places DROP PARTITION 'belgrade';

INSERT INTO geo.places (id, name, category, confidence, lon, lat, city)
SELECT
    id,
    coalesce(names.primary, '')          AS name,
    coalesce(categories.primary, '')     AS category,
    toFloat32(coalesce(confidence, 0.))  AS confidence,
    geometry.1                           AS lon,
    geometry.2                           AS lat,
    'belgrade'                           AS city
FROM s3('https://overturemaps-us-west-2.s3.amazonaws.com/release/2026-06-17.0/theme=places/type=place/*.parquet', 'Parquet')
WHERE bbox.xmin BETWEEN 20.200 AND 20.650
  AND bbox.ymin BETWEEN 44.660 AND 44.920
  AND coalesce(confidence, 0.) >= 0.5
  AND coalesce(operating_status, 'open') != 'closed';

---------------------------------------------------------------------------------
-- Verification. Run this after every load — the H3 trap fails silently, so a load
-- that "succeeded" proves nothing on its own. Expected: drift_m is a few hundred
-- metres and h3_lat/h3_lon sit inside the named city. If Berlin comes back near
-- (13.4, 52.5) the lon/lat columns are swapped.
---------------------------------------------------------------------------------
-- SELECT city, name,
--        round(lat, 4) AS src_lat, round(lon, 4) AS src_lon,
--        round(h3ToGeo(h3_8).1, 4) AS h3_lat,   -- h3ToGeo returns (lat, lon) too
--        round(h3ToGeo(h3_8).2, 4) AS h3_lon,
--        round(geoDistance(lon, lat, h3ToGeo(h3_8).2, h3ToGeo(h3_8).1)) AS drift_m
-- FROM geo.places WHERE name != '' ORDER BY city, id LIMIT 5 BY city;
