# Implementation plan — 17→23 July 2026

**Hard deadline: 23 July 12:00 UTC** (00:00 AoE), server-enforced, no extensions.
Minus the demo video and the flip to public, **effective code time ends 21 July evening.**

That is **four working days**, not six. Plan accordingly.

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
scaling on both terms, derived per query. Top-3: Mariendorf, Hellersdorf, Köpenick — dense
residential, zero bakeries in the ring, and notably *not* the commercial centre.

**What day 3 broke:**
1. **The model invented place names.** First live run: the map was right and the sentence put
   all three picks in *Spandau*, the wrong side of the city. The tools return no place names,
   so it made them up. Prompt now forbids naming districts. **Real district names need Overture
   divisions** — not loaded, and a genuine day-4 candidate: "Mariendorf" is a much better demo
   line than "an underserved area".
2. **The map does not survive a page reload** — ADR-001 assumed it did; it doesn't. Cut, with
   reasons, in the spec's Out of Scope.
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
- **Progressive choreography** — the wave sequence from ADR-001, wired for real.
- **Design integration** — whatever came back from the designer.
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
| **The model states things it cannot know** | **medium** — new, found day 3 | it placed all three Berlin picks in "Spandau" on the first live run. Tools return no place names; the prompt now forbids naming districts. A place name in the answer = the guard regressed |
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
