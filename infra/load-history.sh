#!/usr/bin/env bash
# Load monthly OSM history per (city, trade) from ohsome into geo.poi_history, so the agent can
# advise on TREND, not just today's snapshot. The materialized view geo.category_momentum_mv (see
# db/clickhouse/008_history.sql) turns that raw series into first/last momentum incrementally — the
# ClickHouse showcase this feature exists to demonstrate.
#
# The signal is RELATIVE momentum over recent years, never an exhaustive absolute count: OSM counts
# rise partly because mapping improves, not only because businesses open. That confound, and the
# 2.3% cross-validation against our own Overture bakery count, are documented in 008_history.sql.
#
# Idempotent: each city is replaced via DROP PARTITION before its rows are inserted, so re-running
# is safe. The MV uses only idempotent aggregates (argMin/argMax/min/max), so the states a reload
# re-appends collapse to the same momentum — see 008_history.sql for why that matters.
#
#   ./infra/load-history.sh          # apply schema + load all cities from ohsome + verify
#   ./infra/load-history.sh verify   # verification only, no writes, no ohsome calls
#
# ohsome is free and needs no auth. It can be slow (it walks the whole OSM history), so the loader
# retries each (city, category) once, then skips it with a warning rather than aborting the load —
# a skipped trade writes NO rows and reads as "not enough history", never a fake zero.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# shellcheck source=lib.sh
source infra/lib.sh
load_env

: "${CLICKHOUSE_URL:?missing in .env}"
: "${CLICKHOUSE_PASSWORD:?missing in .env}"

# `ch` and `apply_sql_file` live in infra/lib.sh — shared with load-districts.sh / load-affinity.sh.

# Read momentum for one (city, category) straight from the reloaded raw series geo.poi_history —
# NOT from the geo.category_momentum MV store. This matters: the loader reloads by DROP PARTITION +
# re-INSERT on poi_history, which does NOT un-write the MV's accumulated states, so a category that
# ohsome skipped on a re-run would still show its PRIOR run's momentum in the MV and pass verify on
# stale data — the exact false-green this feature's header claims to avoid (constitution II).
# Reading poi_history directly means a skipped category has no rows -> empty output -> the caller
# fails. (The MV is still what the app reads; it is verified for shape elsewhere, not here.)
pct_change() {
    local city="$1" category="$2"
    ch "SELECT round(100 * (argMax(count, month) - argMin(count, month))
                       / argMin(count, month), 1)
        FROM geo.poi_history
        WHERE city = '$city' AND category = '$category'
        GROUP BY city, category FORMAT TabSeparated"
}

# The three asserted momenta (measured live 2026-07-17, Berlin monthly 2022-01 → 2026-06):
#   cafe             2427 → 2689   +10.8%   must be > 0     (rising)
#   bakery           1504 → 1426    -5.2%   must be in [-10, +10]  (flat — the coverage-maturity proof)
#   charging_station  622 → 1903  +205.9%   must be > 100   (booming)
# Asserted, not printed, because a loader that reports success on an empty or wrong series is the
# failure mode this feature exists to avoid (constitution II).
verify() {
    echo
    log "momentum: the three Berlin trades must move as measured 2026-07-17"
    local cafe bakery ev failed=0

    cafe="$(pct_change berlin cafe)"
    bakery="$(pct_change berlin bakery)"
    ev="$(pct_change berlin ev_charging_station)"

    if [[ -n "$cafe" ]] && awk -v v="$cafe" 'BEGIN { exit !(v > 0) }'; then
        ok "  berlin cafe rising: ${cafe}% (> 0)"
    else
        warn "  berlin cafe: got '${cafe:-<no history>}', want > 0"; failed=1
    fi

    if [[ -n "$bakery" ]] && awk -v v="$bakery" 'BEGIN { exit !(v >= -10 && v <= 10) }'; then
        ok "  berlin bakery flat: ${bakery}% (in [-10, +10])"
    else
        warn "  berlin bakery: got '${bakery:-<no history>}', want in [-10, +10]"; failed=1
    fi

    if [[ -n "$ev" ]] && awk -v v="$ev" 'BEGIN { exit !(v > 100) }'; then
        ok "  berlin ev_charging_station booming: ${ev}% (> 100)"
    else
        warn "  berlin ev_charging_station: got '${ev:-<no history>}', want > 100"; failed=1
    fi

    [[ "$failed" -eq 0 ]] || die "momentum verification FAILED — see warnings above"
}

# The batch load. A python3 helper owns the Overture→OSM tag map and the city bboxes, loops the
# 18 categories × 3 cities, does one ohsome POST each, and per city DROP PARTITION + INSERT its
# rows via the ClickHouse HTTP endpoint. Kept in Python because the retry/skip and the JSON parse
# are far cleaner there than in bash. It gets ohsome and ClickHouse endpoints from the environment.
load() {
    log "loading monthly history from ohsome (18 categories × 3 cities) — this walks OSM history, be patient"
    CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" \
        python3 - <<'PY'
import json, os, sys, time, urllib.request, urllib.parse, urllib.error

OHSOME = "https://api.ohsome.org/v1/elements/count"
CH_URL = os.environ["CLICKHOUSE_URL"].rstrip("/") + "/"
CH_AUTH = "default:" + os.environ["CLICKHOUSE_PASSWORD"]

# Overture category → OSM tag. Verified live 2026-07-17: each returns sensible discriminating
# Berlin counts. This map is the loader's alone (008_history.sql stores Overture names, not tags).
CATEGORIES = {
    "bakery": "shop=bakery",
    "cafe": "amenity=cafe",
    "coffee_shop": "amenity=cafe",
    "restaurant": "amenity=restaurant",
    "bar": "amenity=bar",
    "supermarket": "shop=supermarket",
    "pharmacy": "amenity=pharmacy",
    "gym": "leisure=fitness_centre",
    "hair_salon": "shop=hairdresser",
    "clothing_store": "shop=clothes",
    "hotel": "tourism=hotel",
    "ev_charging_station": "amenity=charging_station",
    "kindergarten": "amenity=kindergarten",
    "elementary_school": "amenity=school",
    "art_gallery": "tourism=gallery",
    "doctor": "amenity=doctors",
    "dentist": "amenity=dentist",
    "bank_credit_union": "amenity=bank",
}

# lon,lat bbox — identical to web/src/trigger/scoring.ts CITIES and infra/load-districts.sh.
CITIES = {
    "berlin": "13.088,52.338,13.761,52.675",
    "amsterdam": "4.68,52.27,5.07,52.44",
    "belgrade": "20.2,44.66,20.65,44.92",
}

START = "2022-01-01"


def log(msg):
    sys.stderr.write("\033[36m›\033[0m " + msg + "\n")
    sys.stderr.flush()


def warn(msg):
    sys.stderr.write("\033[33m!\033[0m " + msg + "\n")
    sys.stderr.flush()


def ch(sql, body=None):
    """One statement over the ClickHouse HTTP interface. Query in the URL, optional INSERT body."""
    url = CH_URL + "?" + urllib.parse.urlencode({"query": sql})
    data = body.encode() if body is not None else b""
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Authorization",
                   "Basic " + __import__("base64").b64encode(CH_AUTH.encode()).decode())
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read().decode()


def ohsome_end_month():
    """Cap the end at the first day of ohsome's latest available month.

    ohsome only holds data up to a moving 'toTimestamp' (2026-06-19 as of writing). Asking for the
    current month's first day (2026-07-01) returns HTTP 404, so we floor toTimestamp to its month
    and, defensively, never exceed the current month either."""
    with urllib.request.urlopen("https://api.ohsome.org/v1/metadata", timeout=60) as r:
        meta = json.load(r)
    to = meta["extractRegion"]["temporalExtent"]["toTimestamp"]  # e.g. 2026-06-19T10:00Z
    avail = to[:7] + "-01"                                        # 2026-06-01
    now = time.strftime("%Y-%m-01", time.gmtime())               # current month, first day
    return min(avail, now)


def fetch_series(bbox, osm_filter, end):
    """One ohsome POST → list of (month 'YYYY-MM-DD', count int). Raises on any non-2xx."""
    payload = urllib.parse.urlencode({
        "bboxes": bbox,
        "filter": osm_filter,
        "time": "{}/{}/P1M".format(START, end),
        "format": "json",
    }).encode()
    req = urllib.request.Request(OHSOME, data=payload, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=300) as r:
        result = json.load(r)["result"]
    return [(row["timestamp"][:10], int(row["value"])) for row in result]


def fetch_with_retry(bbox, osm_filter, end):
    """Retry once on any error (ohsome is slow and occasionally 500s), then give up (return None)."""
    for attempt in (1, 2):
        try:
            return fetch_series(bbox, osm_filter, end)
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, KeyError, TimeoutError) as e:
            detail = ""
            if isinstance(e, urllib.error.HTTPError):
                try:
                    detail = " — " + e.read().decode()[:200]
                except Exception:
                    pass
            if attempt == 1:
                warn("ohsome error ({}){}; retrying once".format(e, detail))
                time.sleep(3)
            else:
                warn("ohsome error ({}){}; skipping".format(e, detail))
    return None


def insert_city(city, rows):
    """DROP PARTITION for the city, then INSERT all its rows. Empty rows → drop only (absent≠zero)."""
    ch("ALTER TABLE geo.poi_history DROP PARTITION {}".format(sql_str(city)))
    if not rows:
        warn("{}: no rows fetched for any category — partition left empty".format(city))
        return 0
    values = ",".join(
        "({},{},'{}',{})".format(sql_str(city), sql_str(cat), month, count)
        for (cat, month, count) in rows
    )
    ch("INSERT INTO geo.poi_history (city, category, month, count) VALUES " + values)
    return len(rows)


def sql_str(s):
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def main():
    end = ohsome_end_month()
    log("ohsome window: {} .. {} (P1M)".format(START, end))
    total = 0
    for city, bbox in CITIES.items():
        rows = []
        skipped = []
        for cat, osm_filter in CATEGORIES.items():
            series = fetch_with_retry(bbox, osm_filter, end)
            if series is None:
                skipped.append(cat)
                continue
            rows.extend((cat, month, count) for (month, count) in series)
        n = insert_city(city, rows)
        msg = "{}: {} rows across {} categories".format(city, n, len(CATEGORIES) - len(skipped))
        if skipped:
            msg += " (skipped: {})".format(", ".join(skipped))
        log(msg)
        total += n
    log("done: {} rows in geo.poi_history".format(total))


main()
PY
}

main() {
    if [[ "${1:-}" == "verify" ]]; then verify; return; fi

    log "applying db/clickhouse/008_history.sql (MV must exist before the loader inserts)"
    apply_sql_file db/clickhouse/008_history.sql

    load

    ok "geo.poi_history: $(ch "SELECT count() FROM geo.poi_history") monthly rows"
    verify
    echo
    ok "geo.category_momentum ready — RELATIVE momentum from OSM history, never an absolute count"
}

main "$@"
