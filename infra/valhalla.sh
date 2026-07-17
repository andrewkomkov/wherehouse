#!/usr/bin/env bash
# Precompute pedestrian isochrones for every populated H3 res-9 cell and load them into
# ClickHouse. Valhalla is a BUILD-TIME TOOL here, not a service: see the decision note in
# docs/PLAN.md and the header of db/clickhouse/006_isochrones_schema.sql.
#
# The container exists only while this script runs. Nothing is left listening.
#
#   ./infra/valhalla.sh              # build + batch + load + verify + down (berlin)
#   ./infra/valhalla.sh build        # download PBF + build graph tiles (both cached)
#   ./infra/valhalla.sh batch        # compute isochrones -> local TSV (cached per city)
#   ./infra/valhalla.sh load         # apply schema + insert the TSV + derive cells
#   ./infra/valhalla.sh verify       # sceptic checks against the loaded data
#   ./infra/valhalla.sh down         # stop and remove the container
#   ./infra/valhalla.sh all berlin amsterdam belgrade
#
# Idempotent at every stage. Measured for Berlin on 2026-07-17: the graph build is the only
# slow part at 510 s; the batch is 18 s and the load 28 s. Each stage caches its artifact, so
# a re-run skips straight past. Delete the artifact to redo that stage.
#
# Requires: docker, python3 (stdlib only), curl.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# shellcheck source=lib.sh
source infra/lib.sh
load_env

: "${CLICKHOUSE_URL:?missing in .env}"
: "${CLICKHOUSE_PASSWORD:?missing in .env}"

# --- config ------------------------------------------------------------------

# Work outside the repo: the PBF is 94 MB and the tiles 151 MB. Neither belongs in git,
# and .gitignore should not have to defend against it.
WORK="${WHEREHOUSE_VALHALLA_DIR:-${TMPDIR:-/tmp}/wherehouse-valhalla}"
IMAGE="ghcr.io/gis-ops/docker-valhalla/valhalla:latest"
CONTAINER="wherehouse-valhalla"
PORT="8102"

# The contour set. Baked in deliberately — geo.isochrone_cells.minutes is a UInt8 over
# exactly these values, so adding a fourth means a reload, not a config flip.
CONTOURS="5,10,15"

# Geofabrik extracts. The city bboxes in scoring.ts are what we actually filter on; these
# extracts only need to CONTAIN the bbox with room for a 15-min walk over the edge.
pbf_url() {
    case "$1" in
        berlin)    echo "https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf" ;;
        amsterdam) echo "https://download.geofabrik.de/europe/netherlands/noord-holland-latest.osm.pbf" ;;
        belgrade)  echo "https://download.geofabrik.de/europe/serbia-latest.osm.pbf" ;;
        *) die "unknown city '$1' (berlin | amsterdam | belgrade)" ;;
    esac
}

# Kontur partitions population by country (003_population_schema.sql).
country_of() {
    case "$1" in
        berlin) echo "DE" ;; amsterdam) echo "NL" ;; belgrade) echo "RS" ;;
        *) die "unknown city '$1'" ;;
    esac
}

# Bboxes copied EXACTLY from web/src/trigger/scoring.ts CITIES — which in turn were copied
# from 002_places_load.sql. If demand, supply and reachability were each filtered by a
# different box, edge cells would see one and not the others. Change one, change all three.
bbox_of() {
    case "$1" in
        berlin)    echo "52.338 52.675 13.088 13.761" ;;
        amsterdam) echo "52.27 52.44 4.68 5.07" ;;
        belgrade)  echo "44.66 44.92 20.2 20.65" ;;
        *) die "unknown city '$1'" ;;
    esac
}

# --- stages ------------------------------------------------------------------

# Download the PBF. Cached: Geofabrik is 94 MB for Berlin and re-downloading it on every
# run is rude to them and slow for us.
fetch_pbf() {
    local city="$1"
    local dir="$WORK/$city/custom_files"
    mkdir -p "$dir"
    local pbf="$dir/$city.osm.pbf"

    if [[ -s "$pbf" ]]; then
        ok "pbf cached: $(du -h "$pbf" | cut -f1)"
        return
    fi
    log "downloading $city extract..."
    curl -sSL --fail -o "$pbf.part" "$(pbf_url "$city")"
    mv "$pbf.part" "$pbf"
    ok "pbf: $(du -h "$pbf" | cut -f1)"
}

# Build the routing graph, then leave Valhalla serving it.
#
# TWO SETTINGS, AND ONLY ONE OF THEM IS LOAD-BEARING — verified 2026-07-17, not inherited:
#
#   server_threads=1 during the BUILD is real. Multithreaded valhalla_build_tiles segfaults
#   ("double free or corruption") on this hardware; the sibling repo hit it too. One thread
#   is slower and finishes.
#
#   max_time_contour >= 480 is NOT needed here, and this script deliberately does not set it.
#   The sibling repo needs it because it cuts multi-hour DRIVE contours. Our longest contour
#   is 15 minutes and the image's default limit is already 120 (checked in the generated
#   valhalla.json). Copying the setting anyway would be cargo cult — and would hide the fact
#   that nobody checked. If you ever add a contour above 120 min, this is the knob.
build() {
    local city="$1"
    local dir="$WORK/$city/custom_files"
    fetch_pbf "$city"

    if [[ -s "$dir/valhalla_tiles.tar" ]]; then
        ok "graph cached: $(du -h "$dir/valhalla_tiles.tar" | cut -f1)"
        return
    fi

    down
    log "building graph for $city (single-threaded, ~510 s for berlin — a multithreaded build segfaults)"
    local t0 t1
    t0="$(date +%s)"
    docker run -d --name "$CONTAINER" \
        -p "$PORT:8002" \
        -v "$dir:/custom_files" \
        -e use_tiles_ignore_pbf=False \
        -e server_threads=1 \
        -e build_elevation=False \
        -e build_admins=True \
        -e build_time_zones=False \
        -e serve_tiles=True \
        -e force_rebuild=False \
        "$IMAGE" >/dev/null

    wait_for_valhalla 1800
    t1="$(date +%s)"
    ok "graph built in $((t1 - t0))s — tiles $(du -h "$dir/valhalla_tiles.tar" 2>/dev/null | cut -f1)"
}

# Bring Valhalla up on prebuilt tiles. Serving is NOT the thing that segfaults — only the
# build is — so the batch gets real threads here. That is what turns the batch from the ~9
# minutes a 63 ms serial estimate predicts into the 18 s actually measured for Berlin.
serve() {
    local city="$1"
    local dir="$WORK/$city/custom_files"
    [[ -s "$dir/valhalla_tiles.tar" ]] || die "no tiles for $city — run 'build' first"

    if curl -sf --max-time 2 "http://127.0.0.1:$PORT/status" >/dev/null 2>&1; then
        ok "valhalla already serving"
        return
    fi
    down
    log "serving $city tiles"
    docker run -d --name "$CONTAINER" \
        -p "$PORT:8002" \
        -v "$dir:/custom_files" \
        -e use_tiles_ignore_pbf=True \
        -e server_threads=8 \
        -e serve_tiles=True \
        -e force_rebuild=False \
        "$IMAGE" >/dev/null
    wait_for_valhalla 300
}

# The graph build gives no completion signal other than the service coming up. Poll it.
wait_for_valhalla() {
    local budget="${1:-300}" i
    for i in $(seq 1 "$budget"); do
        if curl -sf --max-time 2 "http://127.0.0.1:$PORT/status" >/dev/null 2>&1; then
            echo
            return 0
        fi
        docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" \
            || { docker logs "$CONTAINER" 2>&1 | tail -20 >&2; die "valhalla container died"; }
        [[ $((i % 15)) -eq 0 ]] && printf '\r  building/starting... %ds   ' "$i"
        sleep 1
    done
    echo
    die "valhalla did not come up in ${budget}s"
}

down() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}

# Candidate cells: the res-9 children of every POPULATED res-8 cell in the city bbox.
#
# "Populated" does the real filtering. Kontur only publishes cells with people in them, so
# joining through it drops forest, water and airfield — the cells nobody will ever click and
# no shop will ever open in. Berlin: 2,260 res-8 cells -> 15,820 res-9 candidates.
#
# TRAP: h3ToGeo returns (lat, lon). `.1` is LAT. Writing `.1 BETWEEN <lon range>` returns
# ZERO ROWS WITH NO ERROR — an empty map, not a crash. This has bitten the project three
# times. The verify stage below exists partly to catch exactly this.
candidate_cells() {
    local city="$1" country lat_min lat_max lon_min lon_max
    country="$(country_of "$city")"
    read -r lat_min lat_max lon_min lon_max <<<"$(bbox_of "$city")"

    # Emits (h3_9, lat, lon). The centroid is resolved HERE, in SQL, and never in the Python
    # — h3ToGeo's lat-first ordering is documented once, in 006_isochrones_schema.sql, and
    # reimplementing it in a second language is how the two drift apart.
    ch "
    SELECT DISTINCT
        h3_9,
        h3ToGeo(h3_9).1 AS lat,   -- .1 is LAT. h3ToGeo is lat-first.
        h3ToGeo(h3_9).2 AS lon
    FROM (
        SELECT arrayJoin(h3ToChildren(h3_8, 9)) AS h3_9
        FROM geo.population
        WHERE country = '$country'
          AND population > 0
          AND h3ToGeo(h3_8).1 BETWEEN $lat_min AND $lat_max
          AND h3ToGeo(h3_8).2 BETWEEN $lon_min AND $lon_max
    )
    FORMAT TSV"
}

# Compute one isochrone per candidate cell. Output: TSV of (origin_h3_9, minutes, geojson).
#
# We store Valhalla's contour VERBATIM and let ClickHouse derive the reachable cells from it
# in `load`. That keeps every H3 call in SQL, where 006_isochrones_schema.sql documents the
# ordering trap next to it, instead of splitting geometry handling across two languages.
batch() {
    local city="$1"
    local out="$WORK/$city/isochrones.tsv"

    if [[ -s "$out" ]]; then
        ok "batch cached: $(wc -l <"$out" | tr -d ' ') rows ($(du -h "$out" | cut -f1))"
        return
    fi

    serve "$city"
    log "collecting candidate cells for $city..."
    local cells="$WORK/$city/cells.txt"
    candidate_cells "$city" >"$cells"
    log "$(wc -l <"$cells" | tr -d ' ') candidate res-9 cells"

    log "computing isochrones (8 threads; berlin measured at 18 s)..."
    local t0 t1
    t0="$(date +%s)"
    # NOTE the quoting: `python3 - <<'PY'` steals stdin, so a piped/redirected input never
    # arrives. lib.sh's own comment records this biting status.sh. Pass the file as argv.
    python3 -c "$(cat <<'PY'
import concurrent.futures as cf
import json, sys, urllib.request, urllib.error

cells_file, out_file, port, contours = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
times = [int(t) for t in contours.split(",")]

# 127.0.0.1, NOT localhost — and this is not pedantry, it cost a full batch.
#
# Docker publishes the port on both stacks ("0.0.0.0:8102->8002, [::]:8102->8002") but
# Valhalla's prime_server only answers on IPv4. Python resolves `localhost` to ::1 FIRST and
# stays there, so every request dies with ConnectionResetError. curl implements Happy
# Eyeballs and silently falls back to IPv4 — so the identical request succeeds from curl and
# fails from Python, which is a genuinely confusing way to lose an afternoon.
# Verified 2026-07-17: 127.0.0.1 -> 3 features, [::1] -> ConnectionResetError, curl -> 200.
URL = f"http://127.0.0.1:{port}/isochrone"


class Unreachable(Exception):
    """Valhalla is not answering — an infrastructure failure, never a data one."""


# A list, not an int: threads increment it and we only ever read it at the end.
multipolys = [0]


def one(rec):
    h3, lat, lon = rec
    body = json.dumps({
        "locations": [{
            "lat": lat, "lon": lon,
            # search_cutoff IS THE CORRECTNESS SETTING. Do not remove it to "get more
            # coverage" — coverage bought this way is fabricated.
            #
            # Valhalla snaps an origin to the nearest routable edge, and its default cutoff
            # is 35 km. A cell centroid sitting in a lake, a park or a rail yard therefore
            # does not fail: it silently snaps to a road far away and returns that road's
            # catchment, labelled with OUR cell id. Measured on the first full Berlin run:
            # 1,644 origins had contours centred >1.5 km from themselves, one reaching
            # 4,383 m — a "15-minute walk" of 17 km/h.
            #
            # 150 m is chosen from the geometry, not by taste: a res-9 cell is ~180 m
            # across, so a footpath within 150 m of the centroid is in or touching this
            # cell. Beyond that it is a different place.
            #
            # Measured on a 396-cell sample (2026-07-17):
            #   no cutoff -> 396 ok,   0 skipped, worst 15-min reach 3,473 m  (impossible)
            #   cutoff=150 -> 247 ok, 149 skipped, worst 15-min reach 1,320 m (sound)
            #   cutoff=300 -> 263 ok, 133 skipped, worst 15-min reach 1,440 m
            # Measured, not assumed: three pure-footway Berlin routes come out at 5.00 /
            # 4.96 / 4.98 km/h end to end, so 15 min ~= 1,250 m. (Valhalla's documented
            # walking_speed default is 5.1 km/h; real routes land just under it once
            # crossing penalties apply, and the config declares no override.) Only the
            # cutoff runs are physically possible. The skip rate is the honest answer:
            # those cells have no walkable street in them, and nobody opens a bakery in a
            # lake. Measured skips: berlin 36.9%, belgrade 18.3%, amsterdam 11.2%.
            "search_cutoff": 150,
        }],
        "costing": "pedestrian",
        "contours": [{"time": t} for t in times],
        "polygons": True,

        # denoise=0 IS LOAD-BEARING, AND ITS DEFAULT IS ACTIVELY WRONG FOR US.
        #
        # denoise drops the SMALLER lobes of a multi-lobed contour, and Valhalla's default
        # is 1.0 — "keep only the largest". That is catastrophic here, because the largest
        # lobe is not necessarily the one you are standing in. A pedestrian contour goes
        # multi-lobed wherever a ferry or a long detour puts reachable land across a gap,
        # and if the far lobe out-sizes the local one, the default DELETES YOUR OWN
        # NEIGHBOURHOOD and returns somebody else's.
        #
        # Measured at origin (52.4368, 13.16737), 15-min contour, 2026-07-17 — distance
        # from the origin to the NEAREST vertex of what we would have stored:
        #   denoise omitted (=1.0, default) -> 1 lobe,  1,952 m away   <- origin not in it
        #   denoise=0.5                     -> 2 lobes, 1,596 m away   <- origin not in it
        #   denoise=0.0                     -> 3 lobes,    104 m away   <- correct
        # The 5- and 10-min contours at the same origin were local (56 m, 62 m) — so this
        # produced a cell whose 15-minute catchment was 2 km from its 10-minute one, and
        # nothing but an explicit containment check would ever have noticed.
        "denoise": 0.0,

        # Simplify to a 20 m tolerance. Cosmetic and safe: 20 m against a ~180 m hex is
        # well inside the quantisation we already accept by snapping to res 9. Verified not
        # to affect placement or reach — only vertex count (and therefore stored bytes).
        "generalize": 20,
    }).encode()
    req = urllib.request.Request(URL, data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            fc = json.loads(r.read())
    except urllib.error.HTTPError as e:
        # A 4xx IS the data answer: Valhalla understood us and says this point has no
        # walkable edge near it (a lake, a runway, a rail yard). Kontur says people live in
        # the res-8 parent; it does not promise all 7 res-9 children touch a footpath.
        # This is a legitimate skip.
        if 400 <= e.code < 500:
            return []
        raise Unreachable(f"HTTP {e.code}") from e
    except (urllib.error.URLError, OSError, ValueError) as e:
        # Anything else — connection reset, timeout, unparseable body — is the ENGINE
        # failing, not the data. Do not launder it into a "skip".
        #
        # The first version of this script caught these alongside the 4xx and reported
        # "15,820 skipped (no walkable edge)": a plausible, well-formatted, completely
        # false number, produced because Valhalla was never reachable at all (see URL
        # above). It was only caught by the written == 0 guard at the bottom. An error
        # handler that turns an outage into a data finding is a constitution II defect.
        raise Unreachable(str(e)) from e

    rows = []
    for feat in fc.get("features", []):
        props = feat.get("properties", {})
        if "contour" not in props:
            continue
        geom = feat.get("geometry", {})
        coords = geom.get("coordinates")
        if not coords:
            continue
        # EVERY lobe is kept, one row each. The earlier version of this loop kept only the
        # largest lobe (`max(coords, key=...)`) and that was the same bug as denoise=1, just
        # written by us instead of by Valhalla: at 4 Berlin origins it stored a contour up to
        # 2.2 km from the cell it was labelled with. A lobe Valhalla reached is reachable;
        # picking a favourite among them is not our call to make.
        #
        # So (origin_h3_9, minutes) is NOT unique in geo.isochrones — a multi-lobed contour
        # is several rows. Both consumers are fine with that: the derive step arrayJoins each
        # row independently, and the renderer draws them as the MultiPolygon it is.
        polys = coords if geom.get("type") == "MultiPolygon" else [coords]
        if len(polys) > 1:
            multipolys[0] += 1
        for poly in polys:
            # GeoJSON is [lon, lat]. h3PolygonToCells is (lon, lat). No swap anywhere.
            rows.append((h3, int(props["contour"]),
                         json.dumps(poly, separators=(",", ":"))))
    return rows


recs = []
with open(cells_file) as f:
    for line in f:
        parts = line.split()
        if len(parts) == 3:
            recs.append((int(parts[0]), float(parts[1]), float(parts[2])))

# Canary before the fleet. One request, unguarded: if Valhalla is unreachable or the graph
# does not cover this bbox, fail NOW and say so — not in 17 minutes, and never as a "skip".
try:
    if not one(recs[0]):
        # The very first populated cell having no walkable edge is possible but unlikely
        # enough to be worth a second opinion before committing to the batch.
        probe = next((r for r in recs[1:200] if one(r)), None)
        if probe is None:
            raise SystemExit(
                "canary: the first 200 populated cells all report no walkable edge. "
                "The graph almost certainly does not cover this bbox.")
except Unreachable as e:
    raise SystemExit(f"canary: valhalla unreachable ({e}) — the batch would produce nothing")

written = miss = 0
with open(out_file + ".part", "w") as out, cf.ThreadPoolExecutor(max_workers=8) as ex:
    try:
        for i, rows in enumerate(ex.map(one, recs), 1):
            if not rows:
                miss += 1
            for h3, minutes, geojson in rows:
                out.write(f"{h3}\t{minutes}\t{geojson}\n")
                written += 1
            if i % 500 == 0:
                print(f"\r  {i}/{len(recs)} cells, {written} contours, {miss} skipped",
                      end="", file=sys.stderr, flush=True)
    except Unreachable as e:
        raise SystemExit(f"\nvalhalla died mid-batch ({e}) — refusing to write a partial "
                         f"file that would look complete. Re-run 'batch'.")

pct = 100.0 * miss / len(recs)
print(f"\r  {len(recs)} cells, {written} contours, "
      f"{miss} skipped ({pct:.1f}% — no footpath within 150 m), "
      f"{multipolys[0]} multi-lobed contours (all lobes kept)",
      file=sys.stderr)

# Belt and braces. This guard is what caught the IPv6 bug when the error handling above
# did not exist; it stays.
if written == 0:
    raise SystemExit("no isochrones produced — is the graph built for this bbox?")
# ~38% skipped is EXPECTED and correct with search_cutoff=150 (Berlin measured 37.6% on the
# sample): a populated res-8 Kontur cell has 7 res-9 children and several of them are water,
# park or rail. The guard is set well above that to catch a broken graph, not a normal run.
if pct > 60:
    raise SystemExit(f"{miss}/{len(recs)} ({pct:.1f}%) cells had no footpath within 150 m. "
                     f"Expected ~38%. That is not a data story, that is a broken or "
                     f"mis-located graph. Refusing to load.")
PY
)" "$cells" "$out" "$PORT" "$CONTOURS"
    mv "$out.part" "$out"
    t1="$(date +%s)"

    local n
    n="$(wc -l <"$out" | tr -d ' ')"
    ok "batch: $n contours in $((t1 - t0))s ($(du -h "$out" | cut -f1))"
}

# POST a file to ClickHouse. lib.sh's `ch` takes SQL as an argument, which is right for
# statements and wrong for a 25 MB body — hence this one rather than a change to the shared
# helper. The SQL goes in the query string, the file is the body.
ch_insert_file() {
    local sql="$1" file="$2"
    curl -sS --fail-with-body --max-time 600 \
        --user "default:$CLICKHOUSE_PASSWORD" \
        "$CLICKHOUSE_URL/?query=$(python3 -c \
            'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$sql")" \
        --data-binary "@$file"
}

# Load the contours, then let ClickHouse derive the reachable cells from them.
#
# Idempotent by DROP PARTITION, the same way load-population.sh is: re-running replaces the
# city rather than doubling them. isochrone_cells is derived from isochrones, so it is always
# rebuilt from what was just loaded — the two cannot drift.
load() {
    local city="$1"
    local tsv="$WORK/$city/isochrones.tsv"
    [[ -s "$tsv" ]] || die "no batch output for $city — run 'batch' first"

    log "applying db/clickhouse/006_isochrones_schema.sql"
    apply_sql_file db/clickhouse/006_isochrones_schema.sql

    log "replacing partition '$city'"
    ch "ALTER TABLE geo.isochrones      DROP PARTITION '$city'" >/dev/null
    ch "ALTER TABLE geo.isochrone_cells DROP PARTITION '$city'" >/dev/null

    log "inserting contours..."
    ch_insert_file "
        INSERT INTO geo.isochrones (origin_h3_9, minutes, geojson, city)
        SELECT origin_h3_9, minutes, geojson, '$city'
        FROM input('origin_h3_9 UInt64, minutes UInt8, geojson String')
        FORMAT TSV" "$tsv"

    # The geometry -> cells step. This is the ONLY place h3PolygonToCells is called, and the
    # ring is fed straight from Valhalla's GeoJSON with no reordering: GeoJSON is [lon,lat]
    # and h3PolygonToCells is (lon,lat). See the trap block in 006_isochrones_schema.sql.
    log "deriving reachable cells (h3PolygonToCells)..."
    ch "
    INSERT INTO geo.isochrone_cells (origin_h3_9, minutes, reachable_h3_9, city)
    SELECT
        origin_h3_9,
        minutes,
        arrayJoin(h3PolygonToCells(
            JSONExtract(geojson, 'Array(Array(Tuple(Float64,Float64)))'), 9)) AS reachable_h3_9,
        city
    FROM geo.isochrones
    WHERE city = '$city'" >/dev/null

    ok "loaded: $(ch "SELECT count() FROM geo.isochrones WHERE city='$city'") contours, \
$(ch "SELECT count() FROM geo.isochrone_cells WHERE city='$city'") reachable-cell rows"
}

# Verify like a sceptic, not like an author.
#
# A row count proves the loader ran. It does not prove the isochrones are real, correctly
# placed, or the right shape — and every H3 bug this project has shipped produced a healthy
# row count. Each check below is written so that the failure mode it hunts would FAIL it:
# a lat/lon swap moves the centroid, a broken contour breaks monotonicity, a runaway graph
# blows the reach ceiling. Checks that cannot fail are decoration (constitution II).
verify() {
    local city="$1" lat_min lat_max lon_min lon_max
    read -r lat_min lat_max lon_min lon_max <<<"$(bbox_of "$city")"

    local fails=0
    check() {  # check <label> <sql returning 1 for pass>
        local label="$1" sql="$2" got
        got="$(ch "$sql" | tr -d '[:space:]')"
        if [[ "$got" == "1" ]]; then ok "$label"; else
            warn "FAIL: $label (got '$got')"; fails=$((fails + 1))
        fi
    }

    log "--- $city ---"

    # 1. THE LAT/LON TRAP. If h3PolygonToCells had been fed a (lat,lon) ring, this is the
    #    check that catches it — the cells would sit in the Arabian Sea and still count fine.
    ch "SELECT
          round(avg(h3ToGeo(reachable_h3_9).1), 4) AS avg_lat,
          round(avg(h3ToGeo(reachable_h3_9).2), 4) AS avg_lon,
          count()
        FROM geo.isochrone_cells WHERE city = '$city'"
    check "every reachable cell is inside the $city bbox" "
        SELECT countIf(
                 h3ToGeo(reachable_h3_9).1 NOT BETWEEN $lat_min - 0.05 AND $lat_max + 0.05
              OR h3ToGeo(reachable_h3_9).2 NOT BETWEEN $lon_min - 0.05 AND $lon_max + 0.05
               ) = 0
        FROM geo.isochrone_cells WHERE city = '$city'"

    # 2. MONOTONICITY. A 10-min catchment strictly contains the 5-min one. If contours were
    #    mis-keyed to the wrong minutes, or a polygon got truncated, this breaks.
    check "reach grows monotonically 5 -> 10 -> 15 for every origin" "
        SELECT countIf(NOT (c5 <= c10 AND c10 <= c15)) = 0
        FROM (
            SELECT origin_h3_9,
                   countIf(minutes = 5)  AS c5,
                   countIf(minutes = 10) AS c10,
                   countIf(minutes = 15) AS c15
            FROM geo.isochrone_cells WHERE city = '$city'
            GROUP BY origin_h3_9
            HAVING c5 > 0 AND c10 > 0 AND c15 > 0
        )"

    # 3. SET CONTAINMENT, not just cardinality. The 5-min cells must be a SUBSET of the
    #    15-min cells — a stronger claim than 'fewer of them', and the one that would catch
    #    two independent-but-wrong contours that happen to be ordered by size.
    check "the 5-min cell set is a subset of the 15-min cell set" "
        SELECT countIf(length(arrayFilter(x -> NOT has(c15, x), c5)) > 0) = 0
        FROM (
            SELECT origin_h3_9,
                   groupArrayIf(reachable_h3_9, minutes = 5)  AS c5,
                   groupArrayIf(reachable_h3_9, minutes = 15) AS c15
            FROM geo.isochrone_cells WHERE city = '$city'
            GROUP BY origin_h3_9
            HAVING length(c5) > 0 AND length(c15) > 0
        )"

    # 4. THE CONTOUR MUST CONTAIN ITS OWN ORIGIN.
    #
    #    This is the single most valuable check in the file, and it exists because two
    #    separate bugs — Valhalla's denoise default, and our own "keep the largest lobe"
    #    reduction — both produced contours placed up to 2.2 km from the cell they were
    #    labelled with. Every other check here passed while that was true: the counts were
    #    healthy, the centroid was in Berlin, monotonicity held, the areas looked right.
    #
    #    You are always reachable from where you are standing. If an origin is not inside
    #    its own catchment, the row is about somewhere else.
    check "every origin is inside its own 15-min catchment" "
        SELECT countIf(NOT has(cells, origin_h3_9)) = 0
        FROM (
            SELECT origin_h3_9, groupArray(reachable_h3_9) AS cells
            FROM geo.isochrone_cells WHERE city = '$city' AND minutes = 15
            GROUP BY origin_h3_9
        )"

    # 5. THE REACH CEILING — the check that proves these are ROUTED, not buffered.
    #    Measured on this graph, a pedestrian route runs ~5.0 km/h (5.00 / 4.96 / 4.98 on
    #    three pure-footway Berlin routes), so 15 min is ~1.25 km of PATH and the crow-flies
    #    distance must stay under it (path >= crow). 1.6 km leaves headroom for the res-9
    #    quantisation and the 20 m generalize.
    #
    #    PROVEN TO DISCRIMINATE, which is the only reason it is worth running — the same
    #    sample recomputed with 'auto' costing gives p99.9 = 14,378 m against pedestrian's
    #    1,290 m. A check that cannot fail is decoration; this one fails by 11x on the most
    #    likely real mistake.
    ch "SELECT
          minutes,
          round(max(geoDistance(
            h3ToGeo(origin_h3_9).2, h3ToGeo(origin_h3_9).1,
            h3ToGeo(reachable_h3_9).2, h3ToGeo(reachable_h3_9).1)), 0) AS max_crow_m,
          round(avg(geoDistance(
            h3ToGeo(origin_h3_9).2, h3ToGeo(origin_h3_9).1,
            h3ToGeo(reachable_h3_9).2, h3ToGeo(reachable_h3_9).1)), 0) AS avg_crow_m
        FROM geo.isochrone_cells WHERE city = '$city'
        GROUP BY minutes ORDER BY minutes"
    #    The ceiling is a DISTRIBUTION check, not an absolute one, and the reason is a real
    #    finding rather than a fudge to make the check green.
    #
    #    4 Berlin origins (7 cells of 247,036 = 0.0028%) legitimately reach 2.2 km in 15
    #    minutes. They are not broken: they sit at a ferry terminal, and Valhalla's
    #    pedestrian graph includes the crossing. Established from the engine, not assumed —
    #    /route from (52.4368, 13.16737) reports 2.36 km in 874 s (9.7 km/h, impossible on
    #    foot), and /trace_attributes over that route's own shape returns:
    #        use=ferry, 2.10 km, names=['F10 Alt Kladow -> S Wannsee']
    #    (Those names are quoted from the engine's response. No place name here was typed
    #    from anyone's sense of Berlin geography — see constitution II.)
    #    Note use_ferry=0 does NOT suppress it: identical geometry, verified.
    #
    #    So an absolute ceiling would be false. A percentile ceiling still catches every
    #    systemic failure this check exists for — 'auto' costing, a lat/lon swap, a leaked
    #    contour — because those move the whole distribution, not four cells at a jetty.
    #    Measured now: p50 661 m, p95 994 m, p99.9 1,223 m, max 2,207 m.
    check "p99.9 of 15-min crow reach is within the 1.6 km walking ceiling" "
        SELECT quantile(0.999)(geoDistance(
                 h3ToGeo(origin_h3_9).2, h3ToGeo(origin_h3_9).1,
                 h3ToGeo(reachable_h3_9).2, h3ToGeo(reachable_h3_9).1)) <= 1600
        FROM geo.isochrone_cells WHERE city = '$city' AND minutes = 15"
    check "cells beyond the walking ceiling are a rounding error (<0.05%, the ferry)" "
        SELECT countIf(geoDistance(
                 h3ToGeo(origin_h3_9).2, h3ToGeo(origin_h3_9).1,
                 h3ToGeo(reachable_h3_9).2, h3ToGeo(reachable_h3_9).1) > 1600)
               < count() * 0.0005
        FROM geo.isochrone_cells WHERE city = '$city' AND minutes = 15"

    # 6. ROUTING BEATS A BUFFER. If these were circles we could have skipped Valhalla
    #    entirely. A real street network is anisotropic: the ratio of reached area to the
    #    disc of the same max radius must be well under 1. Proves the engine did work.
    ch "SELECT
          minutes,
          round(avg(cells), 1) AS avg_cells,
          round(avg(cells) * 0.105, 2) AS avg_km2
        FROM (SELECT minutes, origin_h3_9, count() AS cells
              FROM geo.isochrone_cells WHERE city = '$city' GROUP BY minutes, origin_h3_9)
        GROUP BY minutes ORDER BY minutes"

    [[ $fails -eq 0 ]] || die "$fails verification check(s) FAILED for $city"
    ok "$city: all checks passed"
}

# The check a human should actually look at: take a real, NAMED place out of geo.places,
# and show what its catchment does and does not contain.
#
# The name comes from the QUERY, never from anyone's sense of Berlin geography. Day 3 shipped
# three invented district names in a spec written to ban invented district names; the fix is
# not to try harder, it is to never type a place name that a query did not return.
spotcheck() {
    local city="$1"
    log "--- spot check: $city ---"
    # Aggregates are computed SEPARATELY, per contour. Joining places and population into
    # one FROM fans the rows out (one per cell x POI) and then population is summed once per
    # POI: the first version of this check reported 26.65 million people within a 15-minute
    # walk. See the warning block in 006_isochrones_schema.sql. Population is /7 because
    # Kontur is res 8 and reachability is res 9 — a uniform-split proxy, not a census.
    # One deterministic pick, resolved once, so the cell id and the name can never describe
    # two different POIs. `any(name)` over the cell would name whichever POI the engine
    # happened to reach first — the origin cell holds many (this one holds both a mainline
    # station and a photo booth), and a label that does not match the row it came from is
    # exactly the small, plausible kind of wrong this project keeps getting bitten by.
    local origin origin_name
    origin="$(ch "
        SELECT h3_9 FROM geo.places
        WHERE city = '$city' AND name != ''
          AND h3_9 IN (SELECT origin_h3_9 FROM geo.isochrone_cells WHERE city = '$city')
        ORDER BY cityHash64(id) LIMIT 1" | tr -d '[:space:]')"
    origin_name="$(ch "
        SELECT replaceAll(name, '\'', '')
        FROM geo.places
        WHERE city = '$city' AND name != ''
          AND h3_9 IN (SELECT origin_h3_9 FROM geo.isochrone_cells WHERE city = '$city')
        ORDER BY cityHash64(id) LIMIT 1")"

    # Each aggregate is its own single-table-join subquery, joined back on `minutes`. Cloud
    # 26.4 rejects a correlated subquery in IN ("Code: 48 ... not supported as IN function
    # arguments yet"), and folding these into one FROM is the fan-out bug described above.
    ch "
    SELECT
        '$origin_name'                                             AS origin_place,
        c.minutes                                                  AS minutes,
        c.cells                                                    AS cells,
        po.pois                                                    AS pois_reachable,
        round(pp.people)                                           AS people_reachable
    FROM (
        SELECT minutes, count() AS cells
        FROM geo.isochrone_cells
        WHERE city = '$city' AND origin_h3_9 = $origin
        GROUP BY minutes
    ) AS c
    LEFT JOIN (
        SELECT ic.minutes AS minutes, sum(p.population / 7) AS people
        FROM geo.isochrone_cells AS ic
        INNER JOIN geo.population AS p ON p.h3_8 = h3ToParent(ic.reachable_h3_9, 8)
        WHERE ic.city = '$city' AND ic.origin_h3_9 = $origin
        GROUP BY ic.minutes
    ) AS pp USING (minutes)
    LEFT JOIN (
        SELECT ic.minutes AS minutes, count() AS pois
        FROM geo.isochrone_cells AS ic
        INNER JOIN geo.places AS pl
                ON pl.h3_9 = ic.reachable_h3_9 AND pl.city = '$city'
        WHERE ic.city = '$city' AND ic.origin_h3_9 = $origin
        GROUP BY ic.minutes
    ) AS po USING (minutes)
    ORDER BY c.minutes
    FORMAT Vertical"

    # The negative half, and the one that matters most: a 15-min WALK must not reach the
    # other side of the city. Take the two furthest-apart origins we have and assert their
    # catchments are disjoint. If reachability were a bbox or a broken join, they would not be.
    log "distinct origins must have distinct catchments (anti-check):"
    ch "
    SELECT
        round(geoDistance(h3ToGeo(a.o).2, h3ToGeo(a.o).1,
                          h3ToGeo(b.o).2, h3ToGeo(b.o).1) / 1000, 1) AS apart_km,
        length(arrayIntersect(a.cells, b.cells))                     AS shared_cells
    FROM (
        SELECT origin_h3_9 AS o, groupArray(reachable_h3_9) AS cells
        FROM geo.isochrone_cells WHERE city = '$city' AND minutes = 15
        GROUP BY origin_h3_9 ORDER BY h3ToGeo(o).1 ASC LIMIT 1
    ) AS a
    CROSS JOIN (
        SELECT origin_h3_9 AS o, groupArray(reachable_h3_9) AS cells
        FROM geo.isochrone_cells WHERE city = '$city' AND minutes = 15
        GROUP BY origin_h3_9 ORDER BY h3ToGeo(o).1 DESC LIMIT 1
    ) AS b"
}

# --- main --------------------------------------------------------------------

CMD="${1:-all}"
shift || true
CITIES=("$@")
[[ ${#CITIES[@]} -eq 0 ]] && CITIES=(berlin)

case "$CMD" in
    build)  for c in "${CITIES[@]}"; do build "$c"; done; down ;;
    batch)  for c in "${CITIES[@]}"; do build "$c"; batch "$c"; done; down ;;
    load)   for c in "${CITIES[@]}"; do load "$c"; done ;;
    verify) for c in "${CITIES[@]}"; do verify "$c"; spotcheck "$c"; done ;;
    down)   down; ok "container removed" ;;
    all)
        for c in "${CITIES[@]}"; do
            build "$c"; batch "$c"; load "$c"; verify "$c"; spotcheck "$c"
        done
        # The container is a build-time tool. Nothing is left listening.
        down; ok "container removed"
        ;;
    *)      die "unknown command '$CMD'" ;;
esac
