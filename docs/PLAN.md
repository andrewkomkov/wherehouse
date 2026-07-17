# Implementation plan — 17→23 July 2026

**Hard deadline: 23 July 12:00 UTC** (00:00 AoE), server-enforced, no extensions.

> ## ⚠️ "Day N" below is a PHASE, not a date. Read this before pacing anything.
>
> The original plan mapped day 1 → 17 Jul, day 2 → 18 Jul, and so on, and budgeted four
> working days. **Reality, from `git log`: days 1 through 4 all landed on 17 July, between
> 10:29 and 13:56.** Four planned days in three and a half hours. At that point there were
> **5 days 22 hours** left on the clock.
>
> The date mapping is therefore fiction, and it is a *dangerous* fiction: it was used to
> justify cuts. ADR-003 was proposed for cutting "for time" when time was never the binding
> constraint. **Do not cut anything for schedule without re-checking the actual clock** —
> `date -u` against 23 Jul 12:00 UTC, not the day number in this heading.
>
> Constitution VI still holds: scope is bounded by the clock and features are ranked against
> the rubric. But *a schedule you have already outrun is not a reason to cut* — that is
> cargo-culting the plan over the situation. Cut things because they don't move a criterion,
> or because they carry real risk. Not because a heading says day 5.

## How features are ranked

Against the rubric, not against how interesting they are (constitution VI):

| Criterion | Weight | What moves it |
|---|---|---|
| Use of ClickHouse & Trigger.dev | 25% | depth + correctness. `chat.agent()` is *mandatory*. |
| Problem Fit | 20% | does it answer "where should I open this?" |
| Technical Implementation | 20% | would this work in production? |
| Innovation | 20% | the progressive map + ClickHouse-as-webserver |
| Scalability & Impact | 10% | real data volumes, real cities |
| Presentation | 5% | the 5-minute video |

Bonus category, separate prize, less competition: **best OLTP + OLAP integration** —
infrastructure already built and verified (ADR-004), needs surfacing in the product.

## The one rule for this week

**Prove the riskiest path before building anything good** (constitution III).

`chat.agent()` reached GA on 2 July 2026. It carries 25% of the score and the entire
theme, and **nobody here has executed it**. Everything in ADR-001 — `data-map` parts,
stable-`id` in-place updates, progressive fill — is read from documentation and
**unverified**. That is the single largest risk in the project, and it is currently
untouched.

---

## Day 1 — 17 July ✅ done

Research, infrastructure, architecture. Half the day, and worth it: five ADR-grade
findings verified against live systems, not docs.

- ✅ ClickHouse Cloud 26.4 live; Cloud REST API scripted end-to-end (`infra/`)
- ✅ **ADR-003 proven**: Cloud serves real `text/html` from a `MergeTree` row; CORS open
- ✅ **ADR-002 proven**: Overture on S3 — Berlin histogram 4.0s cold, H3 density 1.1s
- ✅ **ADR-004 built**: managed Postgres → ClickPipes CDC → ClickHouse, ~20s, and the
  OLTP×OLAP join verified against 75M POIs
- ✅ spec-kit + constitution; CI with secret-scanning; release-please; designer brief

**Cost of day 1:** a wrong choropleth (lat/lon swap) and a broken CDC slot (a `size`
PATCH that restarts without resizing). Both caught, both now in the constitution.

---

## Day 2 — 18 July · **WALKING SKELETON** ✅ gate passed

**Answer: yes — `chat.agent()` behaves as documented, on the one claim that mattered.**

Recorded live in the browser, two writes under `id="map"` 1.5 s apart:

```
t=27977  parts=1 | showing=site 1/2: Kastanienallee corner
t=29577  parts=1 | showing=site 2/2: Boxhagener Platz
```

Part count held at **1** while the content changed — merge on `type`+`id`, last write wins.
ADR-001's load-bearing assumption is now a verified fact, and the project's largest risk is
retired on day 2 as intended.

Also landed: 211,818 Overture POIs across the three cities (H3 verified by distance —
worst case 556 m at res 8, 210 m at res 9); Berlin PMTiles live on
`basemap.slim-shaggy.com` (30.8 MB, cut in 20.3 s; a real tile returns 200 / 198 KB / 100 ms).

**What day 2 broke:** ADR-001 claimed the full payload goes to the UI. There is a **1 MiB
per-record cap** on the chat stream and we already exceed it — Berlin food & drink is
1.27 MiB, res-9 choropleth ~2.2 MiB. Narrow queries are safe; *"show me every restaurant"*
is a hard `ChatChunkTooLargeError`. Fix is the ID-reference pattern with **ClickHouse as
the store** (ADR-003 already proved it serves HTTP with CORS open) — day 3, before any wide
layer ships.

<details>
<summary>Original day-2 plan, for the record</summary>

One question this day answers: *does `chat.agent()` actually do what the docs say?*

**Not specced — this is a timeboxed spike** (constitution VI proportionality: the only
ambiguity is "does the API behave as documented", and only code answers that).

1. `npx trigger.dev@latest init` — project wired, hello-world task deployed
2. A `chat.agent()` with **one** tool that runs **one** hardcoded SQL against ClickHouse
3. It emits **one** `data-map` part
4. The ugliest possible page: MapLibre + `useChat` + `useTriggerChatTransport`, renders
   **one dot**
5. **Then the real test:** write the same `id` twice and confirm the part updates
   **in place** rather than appending. ADR-001 lives or dies here.

No styling. No basemap tuning. No scoring. One dot.

**In parallel** (independent, no dependency on the skeleton):
- `places` table for Berlin/Amsterdam/Belgrade: `INSERT … SELECT … FROM s3(…)`,
  `ORDER BY mortonEncode(...)`, H3 in **MATERIALIZED** columns (constitution II — this is
  where the lat/lon trap lives)
- ~~Berlin PMTiles extract → R2 + the Protomaps Worker on a custom domain~~ **DONE** —
  live at `https://basemap.slim-shaggy.com/berlin/{z}/{x}/{y}.mvt`, 30.8 MB cut in 20.3 s,
  rebuildable with `./infra/basemap.sh`

**Exit gate:** a dot appears on a map, driven by a ClickHouse query, streamed through
`chat.agent()`, and it *moves* when rewritten with the same id.
**If in-place update does not work → stop and redesign ADR-001 the same day.** That is why
this is day 2 and not day 5.

</details>

---

## Day 3 — 19 July · the real answer ✅ gate passed

**"Where should I open a bakery in Berlin?" returns a real, defensible map.** Three layers —
1,460 competitor dots (430 ms), a 2,260-cell GAP choropleth (700 ms), three ranked pins —
assembled progressively, driven by ClickHouse, streamed through `chat.agent()`.

**The 1 MiB cap is retired.** The handle path is live: the browser reads the 549 KiB
choropleth straight from ClickHouse as the readonly `site` user. *"Show me all food and
drink"* — 6,664 points, 781 KiB, a guaranteed `ChatChunkTooLargeError` yesterday — now renders.
An over-budget layer never touches the stream.

**The score is defensible now, and it wasn't before.** The inherited "3 bakeries = saturated"
was measured against reality and is **wrong**: ring supply runs median 1 / p75 4 / **max 64**,
so the constant sat at the p75 and would have flattened a third of Berlin into "fully
saturated", degenerating the answer into "wherever the most people live". Replaced with p95
scaling on both terms, derived per query. Top-3: Lichtenrade, Biesdorf, Mahlsdorf — dense
residential, zero bakeries in the ring, and notably *not* the commercial centre.

**What day 3 broke:**
1. **The model invented place names — and so did we.** First live run: the map was right and
   the sentence put all three picks in *Spandau*, the wrong side of the city. The tools return
   no place names, so it made them up. The prompt now forbids naming districts.

   Then the same bug was found **in our own spec**: the "Mariendorf / Hellersdorf / Köpenick"
   baseline was eyeballed from coordinates and **all three were wrong**. Resolved properly
   against Overture divisions: **Lichtenrade, Biesdorf, Mahlsdorf**. (Day 2's exploration had
   Lichtenrade right; day 3 "corrected" it to a guess.) Constitution II applies to prose in a
   spec exactly as it applies to a claim in code.

   **Fix, proven feasible 19 July, day-4 candidate:** Overture `theme=divisions/type=division_area`.
   Cloud 26.4 reads it natively as `Geometry` (no `readWKB` — the column is already a Variant;
   use `variantElement(geometry,'Polygon'|'MultiPolygon')`). `subtype='macrohood'` is the
   Ortsteil (Lichtenrade), `subtype='locality'` the Bezirk (Tempelhof-Schöneberg). Resolving a
   point takes a bbox prefilter + `pointInPolygon`, sub-second. Precompute `h3_8 → name` into a
   small table and `rankSites` joins on equality — no runtime geometry. Then the naming ban can
   be lifted honestly, and "Lichtenrade" is a far better demo line than "an underserved area".
2. ~~**The map does not survive a page reload**~~ — **this finding is WRONG and the cut was my
   error.** The v4.5.0 changelog says `chat.agent()` conversations survive *"page refreshes,
   client disconnects, redeploys, idle timeouts, and crashes"*, and the SDK ships `sessions.open()`
   plus `sessions`/`onSessionChange` hydration for exactly this.

   My test never persisted the `chatId`, so `useChat` minted a fresh one on mount. I proved
   **a new session is empty** — trivially true — and concluded about **resuming an old one**,
   which I never exercised. Same defect as the district names: verify the adjacent thing,
   conclude about the target. Third time in two days.

   **To do (day 5, cheap):** persist `chatId`, hydrate `sessions`, re-test honestly. Then either
   restore US1 scenario 4 or cut it for a *reason that survives contact with a test*.
3. `h3ToGeo` and `h3ToGeoBoundary` are **lat-first** like `geoToH3`. A swapped bbox returns
   zero rows with **no error**. Now in `CLAUDE.md`.

<details>
<summary>Original day-3 plan, for the record</summary>

Now spec it — `/speckit-specify` the site-selection answer flow, with what day 2 taught us.

**Day 2 hands day 3 three things it must fold in:**
- **The 1 MiB cap is a design input, not a footnote.** Any layer wider than a single
  category needs the ID-reference path (handle on the stream, GeoJSON fetched straight from
  ClickHouse by the browser). Spec it that way from the start rather than retrofitting.
- The skeleton's `showSavedSites` tool is throwaway — it exists to prove the wire, and its
  deliberate double-write should not survive into the real tools.
- **`geo.population` exists, so the GAP score has a real demand term** (Kontur, H3 res 8,
  joins to `geo.places.h3_8` on equality). First run against Berlin bakeries ranks dense
  residential cells with schools and daycares and zero bakeries — Lichtenrade,
  Friedrichshagen, Staaken. That is a defensible answer; a POI-density proxy would have
  pointed at the commercial centre instead.

  **Two known weaknesses for the spec to fix, not inherit:**
  1. *Supply is cell-local.* A bakery 100 m away in the neighbouring hex counts as zero
     competition. Real supply must read a `h3kRing`, not a single cell.
  2. *The saturation constant is invented.* "3 bakeries = saturated" was a throwaway during
     exploration. Either justify it or normalise supply the same way demand is normalised.

- Agent tools: `findCompetitors`, `scoreArea`, `rankSites` — each emits its own layer
- The scoring query: H3 res 8, competitor density, GAP formula
  (`demand × (100 − supply) / 100` — lifted from the sibling project, explainable)
- Map renders 3 real layers: competitor dots, choropleth, top-3 pins
- Model sees `{ rowCount }` only; GeoJSON goes out-of-band (ADR-001)

**Exit gate:** "where should I open a bakery in Berlin?" returns a real, defensible map.

</details>

---

## Day 4 — 20 July · the wow, and the design

- **Isochrones — precomputed, snapped to H3 res 9.** Valhalla runs **locally in Docker as
  a build-time tool**; a Trigger.dev **batch task** precomputes 5/10/15-min contours per
  candidate cell → `h3PolygonToCells` → ClickHouse.
  ⇒ no Valhalla at runtime, no container to keep alive, **and Trigger.dev gets its second
  meaningful role** (25% criterion).

  **This still supports "click anywhere."** Snap the click to its H3 res 9 cell
  (~0.1 km², ~180 m across — imperceptible on a map), look up the precomputed polygon in
  ClickHouse, return it in sub-millisecond. See the decision note below.

  **Measured on this machine (17 July), not estimated:**

  | | |
  |---|---|
  | Berlin PBF (Geofabrik) | 94 MB |
  | Berlin `valhalla_tiles.tar` | **151 MB** (three cities ≈ 400–500 MB) |
  | Graph build | 453 s (7.5 min, `server_threads=1`) |
  | **One 5/10/15-min pedestrian isochrone** | **63 ms**, 1520 bytes |

  ⇒ Berlin ≈ 8.5k cells at res 9 × 63 ms ≈ **9 minutes**. All three cities ≈ 25k cells ≈
  **26 minutes**, single-threaded, on a laptop. Total stored GeoJSON ≈ **38 MB** — nothing
  for ClickHouse.

  This is what settles the runtime-Valhalla question: not cost or difficulty, but that
  **there is nothing to compute at runtime**. Everything Valhalla can answer for our three
  cities fits in half an hour of offline compute and 38 MB.
- Optional 30-min insurance: a hosted isochrone API (Geoapify — 3k credits/day, no credit
  card; or OpenRouteService — 2.5k/day) behind a "live point" path, for clicks outside our
  three cities.
- **If time allows (~½ day):** ship the backfill as a **CF Container (Valhalla + baked
  tiles) driven by a monthly Trigger.dev cron** instead of a laptop script. Answers the
  *"would this work in production?"* half of Technical Implementation (20%). Only after the
  skeleton — see decision note.
- ✅ **Isochrones precomputed — all three cities, 20,724 origins** (`infra/valhalla.sh`,
  `geo.isochrones` + `geo.isochrone_cells`). Valhalla ran as a build-time tool and the
  container is down. **Not yet surfaced in the product** — the data exists, the layer does not.

  **What this cost, and it is the day's best lesson.** The first Berlin load was garbage:
  4.2 km reached in a five-minute walk. Cause was measured, not guessed — Valhalla's
  `search_cutoff` defaults to **35 km**, so a res-9 centroid sitting in a lake, a park or a
  rail yard does not fail; it silently snaps to a road up to kilometres away and returns *that
  road's* catchment under our cell id. 1,644 Berlin origins had contours centred >1.5 km from
  themselves. Fix: `search_cutoff: 150` — chosen from geometry (a res-9 cell is ~180 m across),
  not taste. Price: ~38% of candidate cells are skipped rather than fabricated.

  **Three things about the verification, which is the part worth stealing:**
  1. *The check was not broken — the pipeline was.* It failed correctly and exited non-zero, but
     `load` and `verify` were separate subcommands, so the condemned rows sat in the table,
     queryable, while the cause was investigated. A reviewer read them and saw 47,460 contours
     of garbage with nothing to say they had been rejected. **A failed load must leave no data,
     not bad data.** Verify is now part of load and a failure drops the partition it just wrote.
  2. *The old check only inspected 15 minutes* — and the worst contour was the 5-minute one. It
     caught the bug by luck. A check that inspects a third of the data is a third of a check.
  3. *It is proven to discriminate*: the same sample under `auto` costing gives p99.9 = 14,378 m
     against pedestrian's 1,290 m, and the pre-fix data fails every check. **A check that has
     never failed is decoration.**

  Measured maxima (crow-flies, 5/10/15 min): berlin 597/1259/**2204**, amsterdam 602/1068/1861,
  belgrade 368/949/1325. The Berlin 15-min outlier is a **ferry-served origin** — pedestrians
  board ferries; it is legitimate and covered by the hard ceiling with no special case.
- **Progressive choreography** — the wave sequence from ADR-001, wired for real.
- **Design integration** — the comp landed 20 July (claude.ai/design, `WhereHouse.dc.html`).
  Map-dominant with a floating instrument rail; dark `#0a0c0f`; IBM Plex; teal `#6ff0e0`
  accent with `#FAFF69` spent **only** on the #1 pick; a visible 7-wave **Assembly timeline**
  that names each wave's source (ClickHouse / Valhalla / agent).
  **What we refuse to port**: the comp's four re-weight sliders run on synthetic Gaussians.
  *Low rent* has **no data source at all** and is cut; *Footfall* is renamed **Residents**,
  because Kontur counts people who live in a cell and calling that foot traffic is a
  plausible-sounding falsehood; *Accessibility* waits on real isochrones. The
  `CATCHMENT · MEASURED` chip may only appear once a real Valhalla polygon is on screen.
- **`chat.headStart`** (v4.5.0): time-to-first-chunk 2.8 s → 1.2 s. Cheap, and it is the demo
  video's opening beat. Not yet wired.
- **OLTP surfacing**: "your saved sites vs the market" as a real chat answer (bonus prize).

---

## Day 5 — 21 July · the stunt, then freeze

- **ADR-003 for real**: the app served out of ClickHouse. Page in `web.pages`, Worker in
  front for clean URLs + credential hiding + caching.
  ⚠️ Access DDL only on a settled service — `p_html`/`web_html`/`web_html2` are already
  wedged from doing this during an upgrade.
- Slider re-weighting if time allows (client-side, zero round-trip — proven pattern)
- **Feature freeze, end of day.** Anything unfinished is cut, not rushed.

---

## Day 6 — 22 July · video and submission

- **Demo video.** 5 min max. Opens *directly* on the product — the brief says skip the
  intro. First shot: one question, map assembling itself. Budget half a day; shooting and
  cutting always takes longer than you think.
- Submission text: title (100 ch), tagline (160 ch), summary (500 words), how ClickHouse
  and Trigger.dev are each used.
- **Flip the repo public.** Verify gitleaks is green first — the CI gate exists for
  exactly this moment.
- Submit. Do **not** wait for day 7.

---

## Day 7 — 23 July · buffer only, until 12:00 UTC

If we are writing code on day 7, something went wrong on day 2.

---

## Researched feature backlog — all requested 17 July → **all shipped and verified in-browser**

**STATUS (17 July): F1–F5 are built, browser-verified, and merged to `main`.** Each went through a
spec + an agent workflow (constitution VII), each gate (typecheck + `verify:score` + shellcheck)
green, each adversarial-review finding fixed. Final CI-equivalent sweep passed: gitleaks clean over
all commits, no tracked secrets, shellcheck clean, docs links resolve, `verify:score` 0 mismatches
across all three cities. The descriptions below are kept as the record of *why* each was built and
what was verified live before it was.

Five features were requested and the product owner considers all of them needed. Each was
**de-risked against the live service before being written here** (constitution II/III) — the
verification command and its output are recorded, not a doc claim. They are ranked against the
rubric (constitution VI) and ordered by dependency, not by how interesting they are.

| Feature | Shipped as | Verified in-browser |
|---|---|---|
| F1 walk catchment + Accessibility | `feat(web): walk catchment layer…` | street-following contour, 3rd slider, not-measured state |
| F2 saved-site history (OLTP+OLAP) | `feat(web): saved-site history…` | save→CDC→compare, market gap fills in seconds |
| F5 complementary affinity | `feat(web): complementary-business affinity…` | editorial-tagged neighbours per pick |
| F3 historical momentum | `feat(web): historical momentum…` | rising/flat/saturating sparkline, honest "since '22" |
| F4 dashboard metrics | `feat(web): market-at-a-glance…` | 4 tiles, reactive to the weight sliders |

**Where ClickHouse's showcase features actually belong** (asked directly, answered honestly):
we currently use MATERIALIZED **columns** (`h3_8/h3_9 = geoToH3(...)`, the lat/lon-trap
mitigation) but **zero materialized views** — verified live, `system.tables` has no
`MaterializedView` engine. That is correct, not a gap: an MV over the static `geo.places` would
be decoration (Principle I of not-decorating). MVs earn their place on **growing** data — the
historical rollup (F3) and optionally the CDC stream (F2) — and that is where they go. Likewise
SQL UDFs and dictionaries land in F5, where they do real work.

### F1 — Walk catchment + Accessibility *(IN FLIGHT — spec 002, day-4 slot)*

Already specified (`specs/002-walk-catchment-accessibility/`) and being implemented through an
agent workflow (constitution VII). Not re-described here; see the spec. Its metrics (reachable
population, cells-not-measured) are inputs to the dashboard (F4).

### F2 — Saved-site history: your sites vs the market *(bonus prize: OLTP+OLAP)*

**What**: a persistent history of saved sites, not a one-shot save. Two save flows (a map click
*and* a chat command), a "Saved sites" panel and an agent tool to **return to** past shortlists,
and a comparison — each saved site re-scored against *today's* market, ranked against each other
and against the agent's own top-3. Both the agent and the UI compare.

**Verified live 2026-07-17**: the schema already models this — no new tables.
`oltp.pg_shortlists` (chat_id, user_id, city, business_type, **weights**, created_at) and
`oltp.pg_saved_sites` (label, lat, lon, **h3_8**, score, status, created_at); CDC is live (2 real
rows already replicated). Because a saved site carries `h3_8`, it joins `geo.places.h3_8` /
`geo.population` on **equality, no interpolation** — a seconds-old Postgres row against 75M
Overture POIs. That join *is* the bonus-prize story.

**Mechanism**: save → Postgres → ClickPipes CDC → `oltp.pg_*` (~10 s) → agent tool joins against
the GAP surface. Optional MV: a rollup of the CDC stream if the compare query needs it (measure
first — it is 2 rows today, so probably not until it grows).

**Rubric**: separate bonus prize, less competition, infra already built (ADR-004). High value,
low cost. **Order: first after F1.** Lock the visual-comparison form (pins+metrics panel vs
ranked list) with a spec question when specced.

### F3 — Historical momentum: is this market rising, flat, or saturating?

**What**: a monthly time series per locality per category over ~3+ years, so the agent advises on
*trend*, not just today's snapshot — "open where demand is rising and supply still lags," a signal
the static GAP score cannot see.

**The naive source is dead, and checking killed it**: the public Overture S3 bucket retains only
**two** releases (`2026-05-20`, `2026-06-17`) — verified by enumerating it. There is no 3-year
Overture history to diff.

**The real source, proven feasible**: OSM history via the free, no-auth **ohsome API** (HeiGIT).
Verified live 2026-07-17, Berlin bbox, monthly/yearly counts:

| category | curve | reading |
|---|---|---|
| `shop=bakery` | 1504 → 1427 (2022→2026) | flat/declining — saturated |
| `amenity=cafe` | 2315 → 2663 (2019→2026) | +15% — gentle rise |
| `amenity=charging_station` | 312 → 1727 (2019→2026) | **+450%** — boom |

The signal **discriminates** (flat vs rising vs boom), which is the whole point. And it
**cross-validates**: ohsome's ~1450 bakeries matches our Overture count of ~1,460 to within 1% —
two independent sources agreeing (constitution II).

**The confound, stated not hidden**: OSM counts rise partly because OSM *mapping* improves, not
only because businesses open. Mitigation: (a) restrict to recent years where coverage is mature —
the flat bakery curve proves coverage is *not* dominating recently; (b) frame as **relative
momentum**, never absolute counts; (c) keep the cross-validation as a standing check. If it ever
reads as a coverage artefact, it is labelled a guess, not shipped as fact.

**Mechanism & the MV**: ohsome is a **build-time loader** (like Valhalla) driven by a Trigger.dev
cron; it backfills monthly (city, category, h3_8, month) counts into ClickHouse. A raw
`geo.poi_history` table + an **incremental AggregatingMergeTree materialized view** rolling it
into per-cell monthly trends is the genuine MV use case *and* the "look how much data ClickHouse
holds" flex the owner wants (~40 months × ~2,260 cells × ~10 categories × 3 cities ≈ millions of
rows). ohsome `/groupBy/boundary` with district polygons keeps the backfill to a few calls, not
2,260 — **validate that grouping shape at build time.**

**Rubric**: Innovation + Scalability + the ClickHouse-volume showcase. Higher cost (loader, MV,
honesty framing) than F2/F5. **Order: after F5.**

### F4 — Dashboard framing the map with metrics

**What**: the map stays the main app, but sits inside a dashboard whose metrics make it more
legible. Not a separate BI screen — a frame. It is the **integration surface** where F1/F2/F3/F5
metrics live around the map.

**Proposed metrics (invented, each tied to real data we already compute)**:
- **Top pick**: score + its three components (reachable residents, nearby competitors,
  accessibility) — from F1's `rankSites`.
- **Market**: total competitors, median GAP, % of city underserved, population covered.
- **Honesty**: cells measured vs not-measured — from F1. (Showing where we *stopped* measuring is
  the thing a competitor's demo won't do.)
- **Momentum**: this category's 3-year trend as a sparkline — from F3. "Bakeries −5% · Cafes +15%."
- **Your sites**: saved-site count and best saved score vs market — from F2.
- **Neighbourhood fit**: the affinity score for the top pick — from F5.

**Guardrail (constitution I)**: metrics serve the map, never become a wall of numbers competing
with it. Two sentences of caption stay the ceiling; a number earns its tile only if it changes a
decision. Adhere to the design comp (map-dominant, floating instrument rail); the current
`chat.tsx` rail is already the seed of this.

**Rubric**: Presentation (5%) — but it is 100% of what the judge sees. **Order: last / incremental**
— it needs the other features' metrics to exist, and grows as they land.

### F5 — Complementary-business affinity (a barbershop next door is a plus)

**What**: the advice accounts for *other* nearby trades, not just rivals. For a coffee shop a
barbershop, bookshop or gym nearby is a plus (complementary footfall); a laundromat is neutral;
another coffee shop is the existing competition term (not double-counted here). A per-cell
**neighbourhood-fit** score over the k-ring's business mix, feeding the recommendation.

**Verified live 2026-07-17**: SQL UDFs work on Cloud 26.4 — created `wh_probe_affinity(target,
neighbor)`, called it (`cafe`×`hairdresser` → +1.0, `cafe`×`cafe` → −0.5), dropped it. So the
mechanism is a `CREATE FUNCTION` affinity(target, neighbor)→weight (or a `CREATE DICTIONARY` for a
larger table), applied over `arrayJoin(h3kRing(...))` neighbours — real ClickHouse UDF/dictionary
depth (25% criterion).

**The affinity dictionaries are hand-authored — and that is labelled, not disguised**
(constitution II). They are an editorial heuristic ("we think barbershops and cafes pair"), *not*
a measurement. Two honest options: ship them as clearly-marked editorial weights, or later derive
them from Overture **co-location lift** (which categories actually co-occur with thriving cafes) —
the second is measured but heavier. MVP is the labelled heuristic; the map/tile must say "editorial
affinity," never present it as data. Starter dictionaries to author: cafe/coffee ← {hairdresser,
books, gym, coworking, art} +, {cafe, fast_food} −; bakery ← {supermarket, school, kindergarten} +;
pharmacy ← {clinic, doctors, supermarket} +; etc.

**Rubric**: differentiates the advice, cheap (proven UDF), showcases a ClickHouse feature nothing
else uses. **Order: after F2** (cheap, high showcase-per-hour).

### Suggested order, once F1 lands and is verified in-browser

`F2 (bonus prize, infra ready) → F5 (cheap, UDF showcase) → F3 (history + MV, the volume flex) →
F4 (dashboard, integrates all, grows incrementally)`. Each goes through a spec and an agent
workflow (constitution VII). None is scheduled against a day number — the clock is checked with
`date -u`, and at time of writing there are ~5 d 22 h left.

## What we are NOT building — decided now, so it isn't relitigated at 2am

| Cut | Why |
|---|---|
| MVT vector tiles from SQL | needs 26.6; Cloud is on 26.4 and trails ~2 releases. GeoJSON is fine at our scale. |
| **Runtime** Valhalla answering live clicks | 63 ms × 25k cells ⇒ the whole answer space precomputes in 26 min. There is nothing left to compute at runtime; H3 res-9 snapping keeps "click anywhere". **Note: the *batch* on CF Containers is back in scope — see the decision note.** |
| Auth / multi-user | zero rubric points |
| Payload CMS-style layer catalogue | the sibling project's pattern is good and irrelevant here |
| Whole-Europe scale | three cities is enough to prove it; ingest risk isn't worth 10% |
| More than one basemap theme | two half-done themes < one good one |
| MCP on the service | console-only toggle, marginal value, breaks ADR-001's context bypass if used by the agent |

## Decision note — why runtime Valhalla is cut (researched 17 July)

The question was raised properly: *can we wrap Valhalla in Cloudflare Containers, warm it
before the demo, and handle cold start gracefully in the UI?* It deserves a real answer,
because the instinct is good — "click anywhere, get your catchment" demos better than a
precomputed grid.

**Everything technical clears.** Cloudflare Containers went GA 2026-04-13; we have Workers
Paid. Image size is **not** a constraint: image size = instance disk, and `standard-1`
gives 8 GB disk / 4 GiB RAM. Measured: the Valhalla base image is 228 MB and **Berlin's
tiles are 151 MB** — under 400 MB total, trivially fits. (An earlier reading of 538 MB was
mid-build intermediate data; Valhalla's cleanup stage collapses it. Don't trust a size
taken before the build finishes.) `linux/amd64` only, but the gis-ops image publishes both
arches. POST/JSON passes through the Worker verbatim; no response size cap. Cost ≈
**$1/day**. One container per city is idiomatic (Durable Objects are addressed by name,
`idFromName("berlin")`) — but it solves a problem we don't have.

**What doesn't clear:**
- **Cold start for large images is unpublished.** Docs say "often 1–3s… dependent on image
  size"; there is no number for ~800 MB + Valhalla's tile mmap. Unknown, not small.
- **All container disk is ephemeral.** Sleep → next start gets a fresh disk from the image.
- Do **not** FUSE-mount tiles from R2: the docs warn it isn't POSIX and isn't for
  high-performance I/O, and Valhalla mmaps with random reads — the worst case for it.
- Ironically **Fly.io is better for this workload**: `suspend` dumps VM state and resumes
  in hundreds of ms, *preserving the warmed mmap*. Cloudflare has no equivalent.

**But the deciding argument isn't technical — it's these two:**

1. **It costs a day of four**, on plumbing that is orthogonal to what a ClickHouse
   hackathon is judged on. It makes our ClickHouse story *worse*, not better.
2. **H3 snapping dissolves the requirement entirely.** Snap the click to its res-9 cell —
   ~180 m across, invisible to someone clicking a map — and look the polygon up in
   ClickHouse in sub-milliseconds. The user still gets "click anywhere, get a catchment".
   The difference is that **ClickHouse does the work on stage**, and Valhalla is relegated
   to a build-time tool, which is what it's actually good at.
3. **And then the measurements killed it outright:** 63 ms per isochrone means the entire
   answer space for three cities is ~26 minutes of offline compute and 38 MB of GeoJSON.
   There is nothing left for a runtime service to do. A container would exist purely to
   recompute, on demand and slowly, an answer we already have.

### REVISED 17 July — Valhalla-on-CF is back, but for the *batch*, not the runtime

The decision above stands for **runtime** routing. It does **not** apply to the batch, and
the distinction matters: every objection that killed runtime Valhalla — cold start,
ephemeral disk, mmap latency — **is irrelevant to a job that runs for 26 minutes once a
month.** A batch does not care that it took 40 s to start.

**The argument that changed the call:** *Technical Implementation is 20% of the score and
asks "would this work in production?"* — and "Andrew runs a script on his laptop monthly"
is not production. An autonomous refresh pipeline is a real answer to a real criterion.
That was underweighted first time round.

**But be honest about what it buys.** Berlin's road network moves by metres per month; an
isochrone recomputed in 30 days will be near-identical. The value here is **architectural
autonomy, not data freshness.** Pitch it as *"the pipeline is self-sustaining"* — never as
*"the data is always fresh"*. A sharp judge will check, and the second claim is false.
Real freshness lives in **POIs**, which change constantly and need no Valhalla at all.

**Shape:**
```
Trigger.dev (monthly cron) ─► CF Container (Valhalla + baked tiles, amd64)
                                   │  POST /isochrone × ~25k cells
                                   ▼
                            h3PolygonToCells ─► ClickHouse

Trigger.dev (nightly cron) ─► Overture POI refresh ─► rescore ─► alerts   [no Valhalla]
```

**Cost: ~half a day**, not the full day the runtime version needed — no cold-start tuning,
no sleepAfter, no R2 FUSE. Build tiles natively on arm64, `COPY` the `.tar` into a
`--platform linux/amd64` image (tiles are little-endian and portable, so it's a pure copy
with no QEMU emulation). Push to `registry.cloudflare.com` (Cloudflare does **not** cache
images from Docker Hub/ECR/GAR). `standard-1` (0.5 vCPU / 4 GiB / 8 GB disk) fits ~400 MB
comfortably.

**Hard precondition (constitution III):** this happens **only after the day-2 skeleton
proves `chat.agent()`**. If `data-map` parts don't behave as documented, every Valhalla
plan is irrelevant within the hour. Skeleton first, always.

If day 4 is full when we get here, this is the thing that waits — the nightly POI job
already gives Trigger.dev a meaningful batch role, and it's closer to the product.

Result: no cold start, no image question, no ephemeral disk, no demo-day failure mode, and
a better story. Runtime Valhalla is the right call for the version of this project that has
three weeks — not four days.

**This verdict applies to the *runtime* only.** See the revision immediately below: the
same container, used for the *batch*, is a different question with a different answer.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| ~~`chat.agent()` doesn't behave as documented~~ | ~~critical~~ → **RETIRED 18 Jul** | skeleton ran it end to end; behaves as documented |
| ~~Progressive in-place update doesn't work~~ | ~~high~~ → **RETIRED 18 Jul** | proven live: `parts=1` across two writes to one id, content changed |
| ~~**1 MiB per-record cap kills a wide layer mid-demo**~~ | ~~high~~ → **RETIRED 19 Jul** | handle path live: an over-budget layer never touches the stream. Proven on the 549 KiB choropleth and a 781 KiB competitor layer, both fetched by the browser straight from ClickHouse |
| ~~**The model states things it cannot know**~~ | ~~medium~~ → **RETIRED 20 Jul** | `geo.districts` gives the tools real names (Overture divisions), so the ban is lifted for names a tool returned. **The invariant inverted**: a place name is now the intended outcome; the regression signal is *a name no tool returned*, i.e. a diff against the `rankSites` payload — not a search for capitalised words. Verified live 3×, `place` absent and the user pushing "name the neighbourhoods": zero inventions, it refuses. |
| **DeepSeek balance is $4.87** | medium | a day of iteration, not a week. `check-env.sh` reports it; drop `ANTHROPIC_BASE_URL` to fall back to real Anthropic |
| Designer doesn't deliver in time | medium | brief is out day 1; ship functional-but-plain, style later |
| Cloud reaches 26.6 (or doesn't) | low | assume it doesn't; nothing depends on it |
| CDC slot breaks again | low | `resync` is a one-liner; never touch Postgres `size` |
| We run out of time on the video | **medium** | it's 5% of score but 100% of what the judge sees. Day 6, half a day, non-negotiable. |

## Standing rules

- Verify against the live system, not the docs. State fields lie. (constitution II)
- Nothing pretty on top of anything unproven. (constitution III)
- Infra changes land in `infra/` in the same commit. (constitution IV)
- Secrets never enter git. The CI gate is never weakened. (constitution V)
- Every answer is a visual artifact. Prose is a defect. (constitution I)
