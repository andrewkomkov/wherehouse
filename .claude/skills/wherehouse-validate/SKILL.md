---
name: "wherehouse-validate"
description: "Validate WhereHouse against the hackathon rules — prove every claimed feature is REAL, not stubbed, by checking each against the LIVE system: infra, per-tool SQL, a headless chat.agent() end-to-end run, a no-fakery audit, and the hard rules (MIT, no secrets, build window). Load when asked to validate/verify the project or a feature end-to-end."
user-invocable: true
disable-model-invocation: false
metadata:
  author: "wherehouse"
  domain: "verification"
---

# WhereHouse hackathon-compliance validation

The constitution's rule: **verify against the live system, not the docs — state fields lie.** This
skill proves the whole project (or one feature) is real end-to-end. Work top-down: infra alive → each
agent tool returns real data → the deployed `chat.agent()` runs the whole chain → no fakery in the
code → the hard hackathon rules hold.

## 1. Infra is alive
`./infra/check-env.sh` (all creds vs live services) and `./infra/status.sh` (service state, versions,
saved-site count). Both cover the two SQL identities the saved-site path needs: `site` (public,
readonly — must be able to SELECT `app.saved_sites`, which needs the GRANT) and `app_writer` (the
Worker's INSERT credential). **Always count with `FINAL`:** the table is a ReplacingMergeTree, so a raw
`count()` includes superseded versions and reads high. This once produced a false "CDC lag" alarm
against the old `oltp.pg_saved_sites` (raw 11 vs 2 live); the trap survives its cause.

There is no managed Postgres and no ClickPipe to check any more — retired 2026-08-01, ADR-005.

## 2. Every agent tool returns real data (deterministic, no LLM spend)
Reproduce each tool's SQL directly against ClickHouse and confirm it returns plausible rows matching the
documented measurements. Source `.env`, then `curl --user "default:$CLICKHOUSE_PASSWORD" "$CLICKHOUSE_URL/"
--data-binary "<SQL>"`. The tools + their SQL are in `web/src/trigger/scoring.ts`; reproduce the
`candidateCells` CTE (GAP = demand × (100−supply) × accessibility) for a city+category and check:
- `findCompetitors` → `geo.places` count (Berlin bakery = 1460).
- `scoreArea` → 2260 cells, notMeasured 830 (berlin/bakery).
- `rankSites` → top picks with real district names (Berlin/bakery leads with Lichtenrade, then
  Biesdorf) via the `geo.districts` LEFT JOIN. Match on *names being real and tool-returned*, not a
  frozen ordering: ranks 3–4 are within ~1 gap point and reorder as the composite-demand data
  updates (a second Lichtenrade cell and Bohnsdorf trade places), so do not assert an exact 3rd name.
- `showCatchment` → lobes=1, reachablePeople≈14,780.
- `categoryTrend` → the `geo.category_momentum` MV (bakery −5.2, cafe +10.8, since 2022).
- affinity (`geo.affinity_dict`) → real complementary neighbours per pick.
- saved-sites join → `app.saved_sites FINAL` re-scored against today's `scored` surface. The write
  path is worth proving separately, and non-destructively: `./infra/deploy-app.sh verify` POSTs a
  canary through the deployed Worker, reads it back as the *public* `site` user, then deletes it.
⚠️ **H3 is lat-first** — `h3ToGeo(h3).1` is LATITUDE. A swapped bbox returns ZERO rows with no error.

## 3. The DEPLOYED chat.agent() runs the whole chain (the crown-jewel check)
Drive the same session wire protocol `useTriggerChatTransport` uses, headless, against the prod task —
stronger than a shallow HTTP check. Minimal driver (run from `web/`, needs `TRIGGER_SECRET_KEY_PROD`):
```js
import { auth } from "@trigger.dev/sdk";
import { AgentChat } from "@trigger.dev/sdk/chat";
auth.configure({ accessToken: process.env.TRIGGER_SECRET_KEY_PROD });
const chat = new AgentChat({ agent: "wherehouse-chat", id: "verify-" + Date.now() });
const stream = await chat.sendMessage("where should I open a bakery in Berlin?");
for await (const c of stream) {
  if (c.type === "tool-input-available") console.log("tool", c.toolName, JSON.stringify(c.input));
  else if (c.type?.startsWith("data-") && c.data?.layer) console.log("layer", c.data.layer, c.data.rowCount);
}
try { const { sessions } = await import("@trigger.dev/sdk"); await sessions.close(chat.id); } catch {}
```
A good run calls `findCompetitors → scoreArea → rankSites → showCatchment → categoryTrend`, emits
`data-map` parts (competitors/opportunity(handle)/picks/catchment) + `data-trend`, ends with a caption
that names only tool-returned places. `AgentChat.sendMessage()` returns a `ChatStream` you iterate for raw
UIMessage chunks. Delete the throwaway script after. Each run spends a little DeepSeek — check the balance.
Use this to verify a NEW category too (e.g. "hair salon in Berlin" → competitors count == the trade's POI
count).

## 4. No fakery in the code
Grep the product path (`web/src/`, `infra/`, `db/`) for mock/stub/fake/placeholder/`Math.random`/hardcoded
GeoJSON/canned tool returns/empty catches that fake success. Legit exceptions: the affinity weights are a
**labelled editorial heuristic** (fine — labelled in SQL, tool code, prompt, and UI, kept OUT of the GAP
rank); the synthetic "Low rent" slider was deliberately cut (only the cut comment remains). A worthwhile
independent pass is to spawn a general-purpose subagent to hunt for demo-lying fakery with concrete
file:line evidence.

## 5. The hard hackathon rules
- `LICENSE` is MIT; `git ls-files | grep -iE '\.env$|secret|credential|api-key|\.crt'` finds only
  `.env.example`; `.env` is gitignored (CI gitleaks is the seatbelt — never weaken it).
- Commit timestamps inside the build window (`git log --format=%ci`).
- The answer is VISUAL (the agent's prose is capped at two sentences by `SYSTEM_PROMPT`); ClickHouse is the
  primary DB; `chat.agent()` is used for real (step 3).

## After validating
Report per feature: real / real-with-caveat / broken, each backed by what you ran and saw. Don't say
"verified" without the command + output. If a doc claim can't be reproduced against the live system, the
doc is wrong — surface it (that's the whole point).
