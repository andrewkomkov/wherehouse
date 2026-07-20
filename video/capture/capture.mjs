/**
 * WhereHouse demo capture — Playwright drives the REAL app (and the REAL ClickHouse /play
 * console) and records the screen.
 *
 * Two separate recordings, stitched on the TIMELINE by build.sh's convert step and
 * remotion/src/Video.tsx — never by faking footage:
 *
 *   1. The APP beats (ask, assemble, pick, reweight, scale, compare, close) — one continuous
 *      1920x1080@4K-master video against a running WhereHouse (local dev or the deployed
 *      site), written to ../out/screen.webm.
 *   2. The CONSOLE beat (action "chConsole") — a SEPARATE recording of the real ClickHouse
 *      `/play` web console running the beat's query against `web.assets`, written to
 *      ../out/console.webm. It is captured in its own browser context so it never disturbs
 *      the assembled map the app recording's "close" beat needs.
 *
 * ../out/timings.json carries the MEASURED start/end of every beat, tagged with which source
 * file it plays from (`source: "app"|"console"`) and where in that file its footage begins
 * (`sourceInMs`) — see buildTimeline() below. Remotion renders one Sequence per beat, each
 * pulling from its own source video at its own offset.
 *
 *   APP_URL     where to drive the app beats (default http://localhost:3000; use
 *               https://app.slim-shaggy.com once deployed, for a fully-real, prod capture)
 *   HEADFUL=1   watch it run
 *   SLOWMO      ms of slow-motion between Playwright actions (default 0)
 *
 * Console-beat credentials come from the environment ONLY (source .env first — see
 * build.sh's do_capture): CLICKHOUSE_URL, CLICKHOUSE_CONSOLE_USER, CLICKHOUSE_CONSOLE_PASSWORD
 * — a dedicated READONLY user scoped to `web.assets` alone (infra/create-console-user.sh
 * explains why this can't be CLICKHOUSE_SITE_USER: /play appends its own settings to every
 * request, and readonly=1 rejects ANY settings override — even a no-op one — unless the
 * profile bakes those exact values as its own defaults). Never logged.
 *
 * Usage:  APP_URL=http://localhost:3000 node capture.mjs
 *
 * The agent-driven beats wait on OBSERVABLE app state (a layer appearing, the run going idle)
 * with generous timeouts, and proceed even if a take is thin — this is a capture tool a human
 * (or the video-director agent) re-runs until a take is clean, exactly like shooting real video.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "out");
const RAW = resolve(OUT, "raw");
mkdirSync(RAW, { recursive: true });

const beatsDoc = JSON.parse(readFileSync(resolve(ROOT, "beats.json"), "utf8"));
const { width, height, fps } = beatsDoc.meta;
const APP_URL = process.env.APP_URL || beatsDoc.meta.appUrlDefault;
const HEADFUL = process.env.HEADFUL === "1";
const SLOWMO = Number(process.env.SLOWMO || 0);
const TAIL_MS = 1500; // held on the last frame of the timeline
// The first beat's action only fires once the app is interactive; a slow/cold load is captured as
// dead landing footage ahead of it. We open the OUTPUT timeline on this short, fixed lead-in
// instead (the recording itself is untouched — see the trim in buildTimeline).
const LEAD_IN_MS = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const allIds = beatsDoc.beats.map((b) => b.id);
  const consoleBeat = beatsDoc.beats.find((b) => b.action === "chConsole");
  const appBeats = beatsDoc.beats.filter((b) => b.action !== "chConsole");

  // MAX_BEATS caps how many beats to shoot (counted over the FULL beat list, console
  // included) — a fast smoke take is MAX_BEATS=2 (landing + assembly).
  const maxBeats = Number(process.env.MAX_BEATS || beatsDoc.beats.length);
  const appBeatsToShoot = appBeats.filter((b) => allIds.indexOf(b.id) < maxBeats);
  const shootConsole = !!consoleBeat && allIds.indexOf(consoleBeat.id) < maxBeats;

  // CONSOLE_ONLY=1 re-shoots JUST the console beat (no DeepSeek/agent spend — it never
  // touches chat.agent()) and reuses the app beats already measured in the last take's
  // out/timings.json, reconstructed from their `sourceInMs` (== their original,
  // pre-insertion startMs — see buildTimeline()) and their (insertion-invariant) duration.
  // A re-shoot tool re-run until clean, same spirit as MAX_BEATS.
  let appRun;
  if (process.env.CONSOLE_ONLY === "1") {
    const prev = JSON.parse(readFileSync(resolve(OUT, "timings.json"), "utf8"));
    const prevApp = prev.beats.filter((b) => b.source === "app");
    appRun = {
      videoPath: resolve(OUT, "screen.webm"),
      timings: prevApp.map((b) => ({
        id: b.id,
        caption: b.caption,
        startMs: b.sourceInMs,
        endMs: b.sourceInMs + (b.endMs - b.startMs),
      })),
    };
    console.log("→ CONSOLE_ONLY=1: reusing app beats from the previous out/timings.json");
  } else {
    appRun = await captureApp(appBeatsToShoot);
  }
  const consoleRun = shootConsole ? await captureConsole(consoleBeat) : null;

  const timeline = buildTimeline(allIds, appRun.timings, consoleBeat, consoleRun);
  writeFileSync(
    resolve(OUT, "timings.json"),
    JSON.stringify({ fps, totalMs: timeline.totalMs, beats: timeline.beats }, null, 2),
  );
  console.log(`✓ timings → ${resolve(OUT, "timings.json")}  (total ${(timeline.totalMs / 1000).toFixed(1)}s)`);
}

/**
 * Stitch the app timeline and the (optional) console timeline into one beat list, in the
 * ORDER beats.json declares — reading straight from that order rather than hard-coding which
 * beat the console sits after, so the insertion point moves with the beat sheet, not with
 * this file.
 *
 * App beats keep their MEASURED recording offsets as `sourceInMs` (screen.webm's own
 * timeline never moves) but their TIMELINE `startMs`/`endMs` shift forward by however much
 * console footage has been inserted before them so far. The console beat, once inserted,
 * plays console.webm from `consoleRun.paintOffsetMs` — trimming the blank/black lead-in
 * before the /play page had painted anything, rather than cutting to it on screen.
 */
function buildTimeline(allIds, appTimings, consoleBeat, consoleRun) {
  const appById = new Map(appTimings.map((t) => [t.id, t]));
  const consoleIdx = consoleBeat ? allIds.indexOf(consoleBeat.id) : -1;
  const insertAfterId = consoleIdx > 0 ? allIds[consoleIdx - 1] : null;
  const consoleTrimMs = consoleRun?.paintOffsetMs ?? 0;
  const consoleVisibleMs = consoleRun ? Math.max(1, consoleRun.durationMs - consoleTrimMs) : 0;

  const beats = [];
  let offset = 0;
  for (const id of allIds) {
    if (id === consoleBeat?.id) continue; // placed via insertAfterId below, not by list position
    const t = appById.get(id);
    if (!t) continue; // beat wasn't shot this take (MAX_BEATS)
    beats.push({
      id: t.id,
      caption: t.caption,
      startMs: t.startMs + offset,
      endMs: t.endMs + offset,
      source: "app",
      sourceInMs: t.startMs,
    });
    if (id === insertAfterId && consoleRun) {
      const cStart = t.endMs + offset;
      const cEnd = cStart + consoleVisibleMs;
      beats.push({
        id: consoleBeat.id,
        caption: consoleBeat.caption,
        startMs: cStart,
        endMs: cEnd,
        source: "console",
        sourceInMs: consoleTrimMs,
      });
      // The timeline only ever plays consoleVisibleMs of it, so that's what later beats
      // shift by — not the full raw recording length (which still includes the trimmed lead).
      offset += consoleVisibleMs;
    }
  }
  // Trim the app-load pre-roll: shift the whole OUTPUT timeline so the first beat opens on a short
  // fixed lead-in rather than however long the app took to become interactive. sourceInMs is left
  // alone, so each beat still pulls from its own place in the recording — only the timeline moves.
  if (beats.length) {
    const shift = beats[0].startMs - LEAD_IN_MS;
    if (shift > 0) for (const b of beats) { b.startMs -= shift; b.endMs -= shift; }
  }
  const totalMs = (beats.at(-1)?.endMs ?? 0) + TAIL_MS;
  return { beats, totalMs };
}

/** Capture the app beats as one continuous 4K-master recording. Returns { videoPath, timings }. */
async function captureApp(beats) {
  console.log(`→ capturing app @ ${APP_URL} at ${width}x${height}@${fps} (4K master)`);
  // Capture a 4K MASTER while the app itself is laid out at 1080p (viewport stays 1920x1080 —
  // the UI's rails are sized for that, fixed-px grid-template-columns and all).
  //
  // The obvious way to do this — context-level `deviceScaleFactor: 2` plus `recordVideo.size:
  // {3840,2160}` — does NOT work: Playwright's recordVideo (and CDP's Page.startScreencast under
  // it) captures at the CSS viewport's pixel size regardless of deviceScaleFactor, and its `size`
  // option only ever scales DOWN ("Actual picture of each page will be scaled down if necessary
  // to fit the specified size" — it never scales up). Requesting a size bigger than the CSS
  // viewport just letterboxes: verified empirically — the real content landed unscaled in the
  // top-left 1920x1080 of the 3840x2160 canvas, the rest solid grey padding. That would have
  // shipped a video *labelled* 4K that was still only a 1080p source — exactly the "quality loss"
  // this capture exists to avoid, just hidden a layer deeper.
  //
  // The fix: force the scale factor at the CHROMIUM PROCESS level (`--force-device-scale-factor`)
  // instead of the Playwright context level. With this flag, Chromium's own compositor treats the
  // display as 2x-density and recordVideo's normal (fast, ~25fps, no letterboxing) capture path —
  // which is native at 3840x2160 when that's what the compositor is actually producing — picks up
  // the full-resolution frame. Verified: (a) ffprobe reports 3840x2160 with real content filling
  // every corner, not padding; (b) window.innerWidth still reads 1920 (rails stay full-size — the
  // flag changes pixel density, not the CSS viewport); (c) a 2x crop of a dense hex/dot cluster
  // shows materially smoother edges than a naive 2x nearest-upscale of the old native 1080p
  // capture, i.e. this is genuine extra resolution, not a relabelled upscale.
  const browser = await chromium.launch({
    headless: !HEADFUL,
    slowMo: SLOWMO,
    args: ["--force-device-scale-factor=2", "--high-dpi-support=1"],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: RAW, size: { width: width * 2, height: height * 2 } },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("  [page error]", m.text().slice(0, 140));
  });

  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const timings = [];
  const mark = async (beat, fn) => {
    const start = at();
    console.log(`  ▸ ${beat.id} @ ${(start / 1000).toFixed(1)}s — ${beat.label}`);
    try {
      await fn(beat);
    } catch (e) {
      console.log(`    ! ${beat.id}: ${e.message.slice(0, 120)} (continuing)`);
    }
    timings.push({ id: beat.id, caption: beat.caption, startMs: start, endMs: at() });
  };

  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".wh-land-input", { timeout: 30000 });
  await sleep(1400); // let the landing settle / aura breathe

  const actions = makeActions(page);
  for (const beat of beats) {
    await mark(beat, actions[beat.action] || (async () => sleep(beat.targetMs)));
  }
  await sleep(1500); // tail

  const videoPath = await page.video()?.path();
  await context.close(); // finalizes the webm
  await browser.close();

  let dest;
  if (videoPath) {
    dest = resolve(OUT, "screen.webm");
    writeFileSync(dest, readFileSync(videoPath));
    console.log(`✓ app footage → ${dest}`);
  }
  return { videoPath: dest, timings };
}

/**
 * Capture the console beat: the real ClickHouse `/play` web console, in its OWN browser
 * context/recording, running the beat's query against `web.assets` and holding on the
 * result. Returns { videoPath, durationMs }.
 */
async function captureConsole(beat) {
  const CH_URL = process.env.CLICKHOUSE_URL;
  const CH_USER = process.env.CLICKHOUSE_CONSOLE_USER;
  const CH_PASS = process.env.CLICKHOUSE_CONSOLE_PASSWORD;
  if (!CH_URL || !CH_USER || !CH_PASS) {
    console.log("  ! console beat: missing CLICKHOUSE_URL/CLICKHOUSE_CONSOLE_USER/" +
      "CLICKHOUSE_CONSOLE_PASSWORD in env (source .env first) — skipping console capture");
    return null;
  }
  console.log(`→ capturing console @ ${CH_URL}/play (separate recording)`);

  const browser = await chromium.launch({
    headless: !HEADFUL,
    slowMo: SLOWMO,
    args: ["--force-device-scale-factor=2", "--high-dpi-support=1"],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: RAW, size: { width: width * 2, height: height * 2 } },
    colorScheme: "dark",
  });
  const page = await context.newPage();

  const t0 = Date.now();
  // recordVideo starts at context/page creation, which is a beat before the page has
  // painted anything — the first ~0.2-0.3s of the file is a blank/black frame while
  // Chromium navigates. Measure exactly when the real UI paints (`#url` visible) so the
  // timeline can skip that dead lead-in instead of cutting the console beat in on black.
  let paintOffsetMs = 0;
  try {
    await page.goto(`${CH_URL}/play`, { waitUntil: "domcontentloaded" });
    await page.locator("#url").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    paintOffsetMs = Date.now() - t0;
    await page.locator("#url").fill(CH_URL);
    await page.locator("#user").fill(CH_USER);
    await page.locator("#password").fill(CH_PASS);
    await sleep(500); // let the credential/URL check settle before we start typing the query

    // Type the query with a brief typing animation, so it reads as "entering a query" rather
    // than appearing all at once.
    const query = beat.query || "SELECT 1";
    await page.locator("#query").click();
    for (const ch of query) {
      if (ch === "\n") {
        await page.keyboard.press("Enter");
      } else {
        await page.keyboard.type(ch, { delay: 0 });
      }
      await sleep(10 + Math.random() * 18);
    }
    await sleep(300);

    await page.locator("#run").click();
    // The result table (`#data-table`, inside the `<query-result>` custom element's OPEN
    // shadow root — Playwright's CSS locators pierce open shadow roots automatically) gets a
    // header row plus one `tr` per result row. Wait for the real rows (/index.html, /404.html)
    // to actually render, not just for the request to fire.
    await page.locator("#data-table tr").nth(1).waitFor({ timeout: 20000 });
  } catch (e) {
    console.log(`    ! console: ${e.message.slice(0, 160)} (continuing — take may be thin)`);
  }
  // Hold on the rendered result so the beat has footage to cut to.
  await sleep(7000);

  const durationMs = Date.now() - t0;
  const videoPath = await page.video()?.path();
  await context.close();
  await browser.close();

  let dest;
  if (videoPath) {
    dest = resolve(OUT, "console.webm");
    writeFileSync(dest, readFileSync(videoPath));
    console.log(
      `✓ console footage → ${dest}  (${(durationMs / 1000).toFixed(1)}s, ` +
        `trimming ${paintOffsetMs}ms blank lead-in)`,
    );
  }
  return { videoPath: dest, durationMs, paintOffsetMs };
}

/** Type a string into an element char-by-char, so the screen shows it being written. */
async function typeSlowly(page, selector, text, perChar = 45) {
  const el = page.locator(selector);
  await el.click();
  for (const ch of text) {
    await el.type(ch, { delay: 0 });
    await new Promise((r) => setTimeout(r, perChar + Math.random() * 30));
  }
}

/** Wait until the agent run goes idle again (the top-bar status flips off "assembling"). */
async function waitIdle(page, timeout = 60000) {
  await page
    .waitForFunction(() => {
      const el = [...document.querySelectorAll("span")].find((s) => /assembling|ready/.test(s.textContent || ""));
      return el && /ready/.test(el.textContent || "");
    }, { timeout })
    .catch(() => {});
}

/** Read the live map camera so it can be restored after a cinematic push-in. Returns null if the
 *  app hasn't exposed its MapLibre handle (window.__whMap, set in chat.tsx). */
async function saveCamera(page) {
  return page
    .evaluate(() => {
      const m = window.__whMap;
      if (!m) return null;
      const c = m.getCenter();
      return { lng: c.lng, lat: c.lat, zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() };
    })
    .catch(() => null);
}

/** Ease the live map camera back to a saved state (used to pull out of the pick before the next
 *  city-wide beat). */
async function restoreCamera(page, cam, duration = 1600) {
  if (!cam) return;
  await page
    .evaluate(
      ({ cam, dur }) => {
        const m = window.__whMap;
        if (!m) return;
        m.easeTo({
          center: [cam.lng, cam.lat],
          zoom: cam.zoom,
          bearing: cam.bearing,
          pitch: cam.pitch,
          duration: dur,
          essential: true,
        });
      },
      { cam, dur: duration },
    )
    .catch(() => {});
  await sleep(duration + 150);
}

/** The money shot: a real MapLibre push-in that FRAMES the top pick's spider-web (the reachable
 *  street network), by fitting the camera to the `catchment` source's bounds. This is a genuine
 *  vector zoom — streets and labels re-render crisp, and only the MAP viewport moves, so the two
 *  side rails and the captions never clip (the reason the Remotion Ken-Burns scale had to stay
 *  off — see the video skill's gotcha #2). No-ops cleanly if the handle or the layer isn't there. */
async function zoomToCatchment(page, { duration = 2400 } = {}) {
  const ok = await page
    .evaluate((dur) => {
      const m = window.__whMap;
      if (!m) return false;
      const src = m.getSource("catchment");
      const data = src && src._data;
      if (!data || !data.features || !data.features.length) return false;
      let minX = 180, minY = 90, maxX = -180, maxY = -90;
      for (const f of data.features) {
        const coords = (f.geometry && f.geometry.coordinates) || [];
        for (const c of coords) {
          if (c[0] < minX) minX = c[0];
          if (c[0] > maxX) maxX = c[0];
          if (c[1] < minY) minY = c[1];
          if (c[1] > maxY) maxY = c[1];
        }
      }
      if (minX > maxX) return false;
      m.fitBounds([[minX, minY], [maxX, maxY]], {
        padding: 90,
        maxZoom: 15.5,
        duration: dur,
        essential: true,
      });
      return true;
    }, duration)
    .catch(() => false);
  if (ok) await sleep(duration + 200);
  return ok;
}

function makeActions(page) {
  return {
    // Beat 1 — type the question into the landing omnibar and submit.
    typeLanding: async (b) => {
      await typeSlowly(page, ".wh-land-input", b.text, 55);
      await sleep(500);
      await page.locator(".wh-land-input").press("Enter");
      await sleep(1200); // the transition into the dashboard
    },
    // Beat 2 — the layers stream in. Wait on real state, then hold on the assembled map.
    awaitAssembly: async (b) => {
      await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 20000 }).catch(() => {});
      await waitIdle(page, 60000);
      await sleep(2500); // let the last wave settle on screen
    },
    // Beat 3 — focus the #1 pick's provenance. Click the top row in the runs/picks rail.
    focusTopPick: async (b) => {
      const cam = await saveCamera(page);
      const btn = page.locator("text=/why the #?1 pick|#1 pick/i").first();
      // Short timeout: if the chip is present but not actionable, we don't want the default 30s
      // hang eating the beat — just move on and hold the map.
      if (await btn.count()) await btn.click({ timeout: 3500 }).catch(() => {});
      await sleep(600);
      // Push the real camera into the spider-web, hold on the reachable streets, then pull back
      // out to the city so the next (city-wide) beat starts framed correctly.
      const zoomed = await zoomToCatchment(page, { duration: 2400 });
      await sleep(Math.max(0, b.targetMs - 5600));
      if (zoomed) await restoreCamera(page, cam, 1500);
    },
    // Same as focusTopPick, but ALSO saves the #1 pick first (a real `.wh-save` click, so it goes
    // to Postgres via saveSiteAction — no agent round-trip needed). Used by cities that have no
    // pre-existing saved sites of their own, so a later "compare" beat (`compareSaved`) has a real
    // site for THIS city to re-score — the compare button only renders once `displaySavedSites`
    // is non-empty. Saving first (before the "why the #1 pick?" ask) leaves the CDC replication
    // (~10s) the most possible headroom before the compare beat runs.
    focusTopPickAndSave: async (b) => {
      // Short timeouts on both clicks: if the pick is ALREADY saved (e.g. a re-shoot after a prior
      // take saved it), the save button sits in its "saved" state and is not actionable — the
      // default 30s click timeout would otherwise blow the beat out to ~54s. Capped + caught, it
      // no-ops in a few seconds and the beat holds the pick view as intended.
      const cam = await saveCamera(page);
      const saveBtn = page.locator(".wh-save").first();
      if (await saveBtn.count()) await saveBtn.click({ timeout: 3500 }).catch(() => {});
      await sleep(700);
      const btn = page.locator("text=/why the #?1 pick|#1 pick/i").first();
      if (await btn.count()) await btn.click({ timeout: 3500 }).catch(() => {});
      await sleep(600);
      const zoomed = await zoomToCatchment(page, { duration: 2400 });
      await sleep(Math.max(0, b.targetMs - 6300));
      if (zoomed) await restoreCamera(page, cam, 1500);
    },
    // Generic agent ask through the docked composer.
    ask: async (b) => {
      await typeSlowly(page, ".wh-ask", b.text, 40);
      await sleep(400);
      await page.locator(".wh-ask").press("Enter");
      await waitIdle(page, 60000);
      await sleep(2500);
    },
    // Beat 6 — the OLTP+OLAP compare.
    compareSaved: async (b) => {
      const cmp = page.locator(".wh-compare").first();
      if (await cmp.count()) {
        await cmp.click().catch(() => {});
      } else {
        await page.locator("text=/compare vs the market/i").first().click().catch(() => {});
      }
      await waitIdle(page, 40000);
      await sleep(3000);
    },
    // Beat 8 — the close: no new action needed (the "ask" handler already clears any open
    // provenance popup on submit, so nothing is left covering the map) — just hold on the
    // assembled map while the Ken-Burns camera pulls back (beats.json zoom: s0 1.06 -> s1 1.00).
    showMap: async (b) => {
      await sleep(b.targetMs);
    },
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
