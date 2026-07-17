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

- **Isochrones.** Valhalla in Docker locally → a Trigger.dev **batch task** precomputes
  contours for candidate cells → `h3PolygonToCells` → stored in ClickHouse.
  ⇒ no Valhalla at runtime, the demo can't be killed by a dead container, **and
  Trigger.dev gets its second meaningful role** (25% criterion).
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
| Live isochrones for arbitrary clicked points | needs Valhalla at runtime = a box to keep alive through 29 July. Precompute instead. |
| Auth / multi-user | zero rubric points |
| Payload CMS-style layer catalogue | the sibling project's pattern is good and irrelevant here |
| Whole-Europe scale | three cities is enough to prove it; ingest risk isn't worth 10% |
| More than one basemap theme | two half-done themes < one good one |
| MCP on the service | console-only toggle, marginal value, breaks ADR-001's context bypass if used by the agent |

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
