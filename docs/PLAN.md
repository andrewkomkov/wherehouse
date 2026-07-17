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

## Day 2 — 18 July · **WALKING SKELETON** ← the critical day

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
- Berlin PMTiles extract → R2 (31MB, ~6s) + the Protomaps Worker on a custom domain

**Exit gate:** a dot appears on a map, driven by a ClickHouse query, streamed through
`chat.agent()`, and it *moves* when rewritten with the same id.
**If in-place update does not work → stop and redesign ADR-001 the same day.** That is why
this is day 2 and not day 5.

---

## Day 3 — 19 July · the real answer

Now spec it — `/speckit-specify` the site-selection answer flow, with what day 2 taught us.

- Agent tools: `findCompetitors`, `scoreArea`, `rankSites` — each emits its own layer
- The scoring query: H3 res 8, competitor density, GAP formula
  (`demand × (100 − supply) / 100` — lifted from the sibling project, explainable)
- Map renders 3 real layers: competitor dots, choropleth, top-3 pins
- Model sees `{ rowCount }` only; GeoJSON goes out-of-band (ADR-001)

**Exit gate:** "where should I open a bakery in Berlin?" returns a real, defensible map.

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
| Runtime Valhalla (Cloudflare Containers / Fly.io) | **researched properly — see decision note below.** Not a trap, ~1 day of work, but a bad trade: it's a quarter of the budget spent on plumbing that makes our ClickHouse story *worse*. And H3 snapping dissolves the reason to want it. |
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

### Refresh cadence — don't overbuild this

Roads do not change daily; **isochrones do not need a nightly job.** A one-off backfill now,
then monthly (or incremental, for new cells only) is honest. Rebuilding 25k isochrones every
night to produce a zero delta is theatre.

What *does* change daily is **POIs** — competitors open and close. That's the recurring job
worth having, and it needs no Valhalla at all: refresh from Overture → rescore → alert
("a bakery opened 200 m from your site #3, score −12", ADR-004). That is Trigger.dev's
second meaningful role, and it's genuinely daily.

Note the tension to avoid: *"Trigger.dev triggers Valhalla"* sounds good but requires
Valhalla to be reachable — i.e. hosted — which is the thing we just cut. Either run the
backfill locally (chosen), or run Valhalla **inside** a Trigger.dev task pulling tiles from
R2 (cold start is irrelevant to a batch job — but whether their runtime can host a C++
binary + 151 MB tile store is **unverified**, and verifying it costs a day we don't have).

Result: no cold start, no image question, no ephemeral disk, no demo-day failure mode, and
a better story. Runtime Valhalla is the right call for the version of this project that has
three weeks — not four days.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| `chat.agent()` doesn't behave as documented | **critical** — 25% + the whole theme | day 2 skeleton; fail fast, redesign same day |
| Progressive in-place update doesn't work | **high** — ADR-001 is the innovation story | same gate; fallback = render layers on turn completion (weaker, still visual) |
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
