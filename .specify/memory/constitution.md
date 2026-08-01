# WhereHouse Constitution

Principles for WhereHouse — a geospatial chat agent that answers *"where should I open
this?"* with a live map. Built for the ClickHouse × Trigger.dev Virtual Summer Hackathon
2026 (17–23 July, submission closes 23 July 12:00 UTC, server-enforced).

This constitution outranks habit, taste, and convenience. Every spec, plan and review is
checked against it. It is short on purpose: a 6-day build cannot afford ceremony, so
every principle here has to earn its place by preventing a *specific* way we lose.

## Core Principles

### I. The answer is a visual artifact, never prose (NON-NEGOTIABLE)

The hackathon theme is *"Beyond the Wall of Text"* and the judging lens is verbatim
*"ratio of insight to words. Text is the garnish, not the meal."*

Any feature whose output is a paragraph is a **defect**. If a result can be a shape, a
position, a colour or a motion, it must not be a sentence. Text accompanying an answer is
a caption: two sentences, hard ceiling.

Concretely: agent tools emit `data-*` parts that render as components. A tool that returns
prose for the model to relay has failed its purpose.

### II. Claims are verified against the live system, not the docs (NON-NEGOTIABLE)

Documentation and research agents were wrong or incomplete on day 1 in ways that would
have cost us the build:
- `http_response_headers` on ClickHouse Cloud was reported "untested, probably impossible"
  — it works, and the whole ADR-003 stunt rests on it.
- `geoToH3` is lat-first while every other geo function is lon-first. Getting it backwards
  is **silent**: plausible counts, hexes in the Indian Ocean. We shipped this bug.
- `PATCH /postgres {size}` returns `200`, doesn't resize, and restarts the instance —
  which silently dropped the CDC replication slot while the pipe still reported `Running`.

Therefore: **a claim that matters is a claim that has been executed.** Specs and plans
record the command and the observed output, not the doc URL. "The docs say" is not
evidence. State fields lie; verify with a canary.

When something is unverified, it is labelled unverified — in the spec, in the ADR, and to
the user. Never present a hypothesis in the register of a fact.

**This applies to our own prose exactly as it applies to code.** A sentence in a spec is a
claim; "it looks right" is not a verification. On day 3 the agent was corrected for naming
three Berlin districts it could not know — and the same defect was then found in the spec
that corrected it: *"Mariendorf, Hellersdorf, Köpenick"* had been eyeballed from coordinates
and written down as measured fact. All three were wrong (the day-3 truth, under the two-factor
score of the time, was Lichtenrade, Biesdorf, Mahlsdorf). It survived because the reference SQL
returned no names, so nothing we ran could contradict it.

*(Freshness note, 2026-07-21: composite demand later re-ranked the surface, so re-running the
berlin/bakery query today yields Lichtenrade, Biesdorf and a third Tempelhof cell — not Mahlsdorf.
The day-3 record above is true as of its timestamp; this note exists so the example itself does not
become the stale "verified" number this very principle warns about.)*

Two rules follow, and they are the expensive part of this principle:

1. **A number is not evidence for the words next to it.** Verified coordinates do not verify
   the place name attached to them. Check the claim that was actually made.
2. **An unfalsifiable claim is the dangerous kind.** If no command you run could prove a
   statement wrong, you have not verified it — you have decorated it. Either find the command
   (here: Overture divisions + `pointInPolygon`) or label it a guess.

A plausible, checkable, wrong detail is worse than no detail: it is exactly what a domain
expert on the jury checks first, and it discredits the true things around it.

### III. Prove the riskiest path first

Build the thinnest end-to-end slice before building anything good. `chat.agent()` reached
GA on 2 July 2026 and carries 25% of our score — nobody on this team has run it.

Sequence is therefore always: walking skeleton → widen → polish. A feature is not
"planned" until its riskiest integration has been executed end-to-end, even ugly, even
with one hardcoded point. Discovering an API doesn't behave as documented is worth days on
day 2 and worth nothing on day 6.

Corollary: no beautiful component may be built on top of an unproven integration.

### IV. Infrastructure is reproducible code

Every cloud resource is created through the REST API and lives in `infra/`, idempotent —
that covered the managed Postgres and the CDC pipe while they existed, and it is why deleting
them was five documented API calls rather than archaeology. **A console click is a bug**: it
evaporates the moment the service is recreated, and the deadline is server-enforced.

If you change infrastructure, `infra/` changes in the same commit. The live OpenAPI spec
(`https://api.clickhouse.cloud/v1`) is ground truth over any documentation.

### V. Secrets never enter git

The repo is private now and **must be public under MIT by 23 July 12:00 UTC** — with live
ClickHouse and Trigger.dev credentials sitting in a local `.env`. A leaked credential in git
history is not fixable by deleting a file.

`.env`, `.secrets/`, and credential drops are gitignored; CI gates on gitleaks plus a
tracked-credentials check. **This gate is never weakened, skipped, or worked around.**

### VI. Scope is bounded by the clock, and the clock is not negotiable

23 July 12:00 UTC, server-enforced, no extensions — minus time for the 5-minute demo video
and the flip to public. Effective code time ends ~21 July.

Every spec states what it cuts. Features are ranked against the rubric (Use of
ClickHouse & Trigger.dev 25% · Problem Fit 20% · Technical Implementation 20% ·
Innovation 20% · Scalability 10% · Presentation 5%), not against how interesting they are.
A feature that doesn't move a criterion doesn't get built.

### VII. Work is executed through agents, and reproducible from a script

Non-trivial work is done by **agents orchestrated from a script**, not by hand-driving a
terminal. The script is the record: re-running it reproduces the result, and reading it
explains how the result was reached — without archaeology.

This generalises Principle IV from infrastructure to *everything*. "A console click is a
bug" because it evaporates the moment the thing must be rebuilt; a manual sequence of edits
and commands is the same bug wearing different clothes. If the only account of how something
was built lives in a person's memory or a scrollback buffer, it is not reproducible — and on
a server-enforced deadline, at 2am on the 22nd, that is the risk that ends the build.

Two rules follow:

1. **Prefer orchestrating agents over doing the work inline**, and **persist the
   orchestration** — the Workflow script, the `infra/` script, the check — so it can be
   re-run and audited. A swarm that ran once and left no script is a console click.
2. **Every deliverable must be regenerable by one command.** If reproducing it requires
   remembered steps, the steps are the defect: write them down as a script.

This is not a licence for ceremony on a one-line fix — Principle VI still bounds it, and the
test is unchanged: *would getting this wrong, or being unable to redo it, cost more than an
hour?* If yes, an agent does it from a script that survives.

## Technical Constraints

- **ClickHouse is the primary database.** Not a cache, not a sidecar — a rules requirement.
  Since ADR-005 it is also the *only* database: the managed Postgres and the ClickPipes CDC
  pipe of ADR-004 were retired once the hackathon closed.
- **Trigger.dev `chat.agent()` is mandatory** per the rules; superficial use is
  disqualifying.
- **Cloud runs 26.4** (`fast` channel) and trails open-source ~2 releases. `GeoJSON`
  format and MVT functions need 26.6 — **do not plan on them arriving before the deadline.**
- Large payloads go to the UI, never through the model's context. Tools return summaries
  (`{ rowCount }`); the GeoJSON goes out-of-band.
- Geo compute (H3) lives in `MATERIALIZED` columns, never inline in queries — see II.
- Docs, specs and code comments in English (the repo goes public to an international
  jury); conversation with the user in Russian.

## Development Workflow

Non-trivial features go through spec-driven development. Artifacts live in `specs/`:

1. `/speckit-constitution` — this file
2. `/speckit-specify` — the spec
3. `/speckit-plan` — implementation plan
4. `/speckit-tasks` — task breakdown
5. `/speckit-implement` — build it

Optional but valuable: `/speckit-clarify` (before `/speckit-plan`), `/speckit-analyze`
(after `/speckit-tasks`), `/speckit-checklist` (after `/speckit-plan`).

**Proportionality clause.** This is a 6-day hackathon. Spec-driven means *think before you
type*, not *generate paperwork*. A spec that takes longer to write than the feature takes
to build has violated Principle VI. Trivial changes — a fix, a doc edit, a colour tweak —
go direct. The test for whether a change needs a spec: *would getting this wrong cost more
than an hour?*

Architecture decisions are recorded as ADRs in `docs/architecture/`, and an ADR states
plainly what is **proven** versus what is **assumed**.

Commits follow Conventional Commits; release-please owns versioning and `CHANGELOG.md`.

## Governance

This constitution supersedes other practices. Where it conflicts with convenience,
it wins.

Amendments are made by editing this file with a rationale in the commit message, and the
version below is bumped. Principles marked NON-NEGOTIABLE may not be suspended for
expedience — they exist precisely because expedience is what would break them.

Reviews verify compliance. Complexity must be justified against Principle VI.
Runtime guidance for agents lives in `CLAUDE.md`; where `CLAUDE.md` and this constitution
disagree, this file wins and `CLAUDE.md` gets fixed.

**Version**: 1.2.2 | **Ratified**: 2026-07-17 | **Last Amended**: 2026-08-01

*1.2.2 — Factual refresh, no principle changed: the managed Postgres and ClickPipes CDC pipe
named in the Technical Constraints, Principle IV and Principle V were retired with ADR-005, so
the text no longer describes infrastructure that exists. Principle II's `PATCH /postgres {size}`
example is deliberately KEPT — it is a record of how a state field lied, and that lesson does
not expire with the instance.*

*1.2.1 — Added a freshness note to Principle II's day-3 example: composite demand re-ranked the
surface, so the illustrative "Lichtenrade, Biesdorf, Mahlsdorf" top-3 no longer reproduces. The
example was itself becoming the stale verified number the principle warns about; caught by a live
validation pass.*

*1.2.0 — Added Principle VII: work is executed through agents orchestrated from a script, and
every deliverable is reproducible by one command. Generalises IV (infra is code) to all work.*

*1.1.0 — Principle II extended to our own prose, after a spec was found asserting three
invented district names as measured fact, hours after the agent was corrected for the
identical mistake.*
