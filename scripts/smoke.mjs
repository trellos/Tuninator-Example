/**
 * Headless smoke test.
 *
 * Builds the demo, serves it with `vite preview`, drives it in headless Chromium
 * against the MOCK source (no microphone, no permission prompt) and asserts that
 *
 *   1. the page loads with no console errors and no page errors,
 *   2. both library streams actually flowed (pitchFrames + the Note lifecycle),
 *   3. at least one Note reached `lifecycle === "resolved"` and at least one
 *      BLOOMED -- gained `harmony` after it had already started, which is the
 *      behaviour the 0.2 model exists for,
 *   4. the canvas really painted -- verified by reading pixels back, not by
 *      trusting that the element exists,
 *   5. the note log filled with starts and ends,
 *
 * then saves `screenshot.png` in the repo root as visual evidence.
 *
 * `--live` additionally drives the REAL library against Chromium's fake audio
 * device, checking that a bad `workletUrl` surfaces `worklet-load-failed`
 * cleanly and that a good one reaches `listening`. That is kept out of the
 * default run because it depends on the sibling library checkout being built.
 *
 * Chromium is preinstalled; this never downloads a browser.
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers  ->  /opt/pw-browsers/chromium
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const PORT = Number(process.env["SMOKE_PORT"] ?? 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** One full 16-beat loop at 90bpm, so the screenshot shows the whole phrase. */
const OBSERVE_MS = 11_500;
const INCLUDE_LIVE = process.argv.includes("--live");

function resolveChromium() {
  const explicit = process.env["CHROMIUM_PATH"];
  if (explicit && existsSync(explicit)) return explicit;
  const browsersPath = process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? "/opt/pw-browsers";
  const candidate = path.join(browsersPath, "chromium");
  if (existsSync(candidate)) return candidate;
  return undefined; // fall back to playwright's own lookup
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`))
    );
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`preview server did not come up at ${url}`);
}

const failures = [];
function check(label, ok, detail = "") {
  const line = `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  if (!ok) failures.push(label);
}

/**
 * Something observed that is neither a pass nor a failure of this repo.
 *
 * Used where the library stopped supplying something the demo can display but
 * never promised (both per-channel `PitchFrame` fields are optional). Printing
 * it keeps the observation in the run output instead of turning a check
 * vacuous — a check that cannot fail is worse than no check at all.
 */
function note(label, detail = "") {
  console.log(`NOTE  ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Installs a `getUserMedia` shim that synthesises a two-channel MediaStream.
 *
 * Registered once; the scenario is chosen per navigation with `?shim=`, because
 * `addInitScript` accumulates for the lifetime of the page and two competing
 * overrides of `getUserMedia` would depend on registration order.
 *
 *   shim=silent-ch0 — 220Hz sawtooth on channel 1, channel 0 unconnected. The
 *                     2-in interface with a guitar in input 2.
 *   shim=comb       — ONE 164.81Hz (E3) sawtooth captured twice: a DI on
 *                     channel 0 and a cab mic 3ms away (about a metre of air)
 *                     on channel 1.
 */
async function installMediaShim(page) {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    window.__stereoShim = { constraints: null, used: false, mode: null };
    media.getUserMedia = async (constraints) => {
      const mode = new URLSearchParams(location.search).get("shim");
      if (!mode) return original(constraints);

      window.__stereoShim.constraints = JSON.parse(JSON.stringify(constraints ?? {}));
      window.__stereoShim.used = true;
      window.__stereoShim.mode = mode;

      // Keep a reference on window: a garbage-collected AudioContext stops the
      // oscillator and the "stream" goes quiet halfway through the test.
      const context = new AudioContext();
      window.__stereoShim.context = context;
      const merger = new ChannelMergerNode(context, { numberOfInputs: 2 });
      const destination = new MediaStreamAudioDestinationNode(context, { channelCount: 2 });
      merger.connect(destination);

      if (mode === "comb") {
        // One guitar, two captures. This is an ordinary rig, and summing it is
        // the thing channel selection exists to avoid: 3ms is half a period of
        // 166.7Hz, so at E3 the two copies arrive in antiphase, the odd
        // harmonics cancel, and the sum's strongest periodicity is an octave up.
        const oscillator = new OscillatorNode(context, { frequency: 164.81, type: "sawtooth" });
        const di = new GainNode(context, { gain: 0.3 });
        const mic = new GainNode(context, { gain: 0.24 });
        const delay = new DelayNode(context, { delayTime: 0.003, maxDelayTime: 0.05 });
        oscillator.connect(di);
        di.connect(merger, 0, 0);
        oscillator.connect(delay);
        delay.connect(mic);
        mic.connect(merger, 0, 1);
        oscillator.start();
      } else {
        const oscillator = new OscillatorNode(context, { frequency: 220, type: "sawtooth" });
        const gain = new GainNode(context, { gain: 0.3 });
        oscillator.connect(gain);
        // Input 1 of the merger is channel 1. Channel 0 is left unconnected,
        // i.e. exactly the silence an unused mic input produces.
        gain.connect(merger, 0, 1);
        oscillator.start();
      }

      return destination.stream;
    };
  });
}

/** Starts the demo's REAL live path against the shim and waits for `listening`. */
async function listenWithShim(page, query) {
  await page.goto(`${ORIGIN}/?mock=0&${query}`, { waitUntil: "load" });
  await page.click("#listen-btn");
  await page.waitForFunction(
    () => document.getElementById("state-pill")?.textContent === "listening",
    undefined,
    { timeout: 15_000 }
  );
  // Long enough for the channel selector's 250ms window to close and latch.
  await page.waitForTimeout(3000);
}

/** Reads the demo's per-channel diagnostics panel. */
function readChannelPanel(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("#channel-meters .channel-row")];
    return {
      count: rows.length,
      note: document.getElementById("channel-note")?.textContent ?? "",
    };
  });
}

/**
 * Regression test for the stereo-interface bug.
 *
 * A 2-in interface ("Analogue 1/2 (Audient iD4)") is a single *stereo* device to
 * the browser, so an instrument plugged into input 2 exists only on channel 1.
 * Every link in the chain can silently drop it -- getUserMedia can open the
 * device in mono, and the worklet can read channel 0 and nothing else -- and the
 * failure is invisible: no pitch, no level, no error, exactly like a detector
 * that does not work at all.
 *
 * So: 220Hz on channel 1, silence on channel 0, driven through the demo's REAL
 * live path end to end. This exercises the whole chain -- constraints,
 * MediaStreamAudioSourceNode, the worklet node's channel configuration, the
 * worklet's channel handling -- against the exact signal shape that used to
 * produce silence.
 */
async function runStereoChannelCheck(page) {
  await listenWithShim(page, "shim=silent-ch0");

  // 0.2 asks for `channelCount: { ideal: 2 }` rather than a bare 2, so a
  // genuinely mono microphone still opens instead of being over-constrained.
  const constraints = await page.evaluate(() => window.__stereoShim?.constraints ?? null);
  const requested = constraints?.audio?.channelCount;
  check(
    "stereo: getUserMedia was asked for 2 channels",
    requested === 2 || requested?.ideal === 2,
    JSON.stringify(constraints?.audio ?? null)
  );

  const noteText = (await page.locator("#note-name").innerText()).trim();
  const frequencyText = (await page.locator("#frequency-value").innerText()).trim();
  const hz = Number.parseFloat(frequencyText);
  check(
    "stereo: a tone present ONLY on channel 1 is still detected",
    noteText === "A" && Math.abs(hz - 220) < 3,
    `${noteText} @ ${frequencyText}`
  );

  const probe = await page.evaluate(() => window.__tuninatorDemo ?? null);
  check(
    "stereo: pitch frames flowed from the two-channel stream",
    (probe?.frames ?? 0) > 50,
    `frames=${probe?.frames}`
  );

  // `PitchFrame.channelRms` / `.selectedChannel` are optional, and 0.2's browser
  // adapter populates neither: the capture worklet measures them and
  // `BrowserRecognizer` drops them on the way to the engine. So which channel
  // was selected cannot be asserted from here -- the check above, that the tone
  // is detected at all, is what still proves selection happened.
  //
  // Reported rather than checked, because a demo cannot fix a library. The
  // demo's job is to say so rather than draw an empty meter, and that IS
  // checked. If a later revision starts forwarding the fields, the mock-path
  // check already covers rendering them.
  const channels = await readChannelPanel(page);
  note(
    "stereo: per-channel diagnostics are not reported by this library revision",
    `channelRms=${JSON.stringify(probe?.channelRms)} ` +
      `selectedChannel=${JSON.stringify(probe?.selectedChannel)}`
  );
  check(
    "stereo: the demo says the channels are unreported rather than drawing an empty meter",
    channels.count === 0 && channels.note.includes("not reported"),
    `${channels.count} rows, note="${channels.note}"`
  );
}

/**
 * The reason selection exists rather than summing.
 *
 * A DI and a cab mic of the SAME guitar is an ordinary rig, and the mic's
 * acoustic delay makes the two channels a comb filter when they are added
 * together. At 3ms (about a metre of air) the null lands on the odd harmonics
 * of E3, and the sum that reaches the detector reads an octave high.
 *
 * Both halves are asserted, against the same synthetic rig:
 *   - `channels=sum` (the old behaviour, still available as an option) is wrong,
 *   - the default `auto` picks one channel and is right.
 *
 * If summing ever stops failing here the first check is what says so, rather
 * than the suite quietly passing on a claim it no longer tests.
 *
 * Both are read off the pitch readout. 0.2 stopped delivering
 * `PitchFrame.selectedChannel`, so the two results *differing* is now the only
 * evidence that `auto` is not summing -- which is why neither half may be
 * dropped for being redundant with the other.
 */
async function runCombFilterCheck(page) {
  const E3 = 164.81;
  const readPitch = async () => {
    const note = (await page.locator("#note-name").innerText()).trim();
    const hz = Number.parseFloat((await page.locator("#frequency-value").innerText()).trim());
    return { note, hz };
  };

  await listenWithShim(page, "shim=comb&channels=sum");
  const summed = await readPitch();
  check(
    "comb: summing a DI and a 3ms-delayed mic of one guitar reads an octave high",
    Number.isFinite(summed.hz) && summed.hz > E3 * 1.8,
    `${summed.note} @ ${summed.hz}Hz (source is E3, ${E3}Hz)`
  );

  await listenWithShim(page, "shim=comb");
  const selected = await readPitch();
  check(
    "comb: the default `auto` reads E3, not the octave summing produces",
    selected.note === "E" && Math.abs(selected.hz - E3) < 4,
    `${selected.note} @ ${selected.hz}Hz`
  );

  // The pair above is the whole claim, and it is now carried entirely by the
  // pitch readout: `selectedChannel` would have said which channel won, but 0.2
  // does not deliver it (see runStereoChannelCheck). The two results differing
  // is what proves `auto` is not summing.
  const probe = await page.evaluate(() => window.__tuninatorDemo ?? null);
  note(
    "comb: the library did not name the channel it settled on",
    `selectedChannel=${JSON.stringify(probe?.selectedChannel)}`
  );
}

async function main() {
  console.log("→ building");
  await run("npx", ["vite", "build", "--logLevel", "warn"]);

  console.log(`→ serving on ${ORIGIN}`);
  const server = spawn(
    "npx",
    ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let browser;
  try {
    await waitForServer(ORIGIN);

    const executablePath = resolveChromium();
    console.log(`→ launching chromium (${executablePath ?? "playwright default"})`);
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        // Only relevant to --live: give the real library a synthetic input
        // device instead of a permission prompt it can never satisfy.
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 2, // also exercises the devicePixelRatio path
    });

    const consoleErrors = [];
    const pageErrors = [];
    const badResponses = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    // A bare "Failed to load resource" console error does not say *which*
    // resource; record the URL so a failure is actionable.
    page.on("response", (response) => {
      if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
    });

    // Mock source + metronome on, so the beat grid and the audio scheduler run.
    await page.goto(`${ORIGIN}/?mock=1&metronome=1`, { waitUntil: "load" });
    await page.waitForSelector("#timeline-canvas");

    check("page has a canvas", (await page.locator("#timeline-canvas").count()) === 1);
    check(
      "source badge reports the mock",
      (await page.locator("#source-badge").innerText()).includes("mock")
    );

    await page.click("#listen-btn");
    await page.waitForFunction(
      () => document.getElementById("state-pill")?.textContent === "listening",
      undefined,
      { timeout: 10_000 }
    );
    check("state reached `listening`", true);

    console.log(`→ observing for ${OBSERVE_MS}ms (one full 16-beat phrase)`);
    await page.waitForTimeout(OBSERVE_MS);

    // --- streams actually flowed -------------------------------------------
    const probe = await page.evaluate(() => window.__tuninatorDemo ?? null);
    check("pitchFrame stream flowed", (probe?.frames ?? 0) > 100, `frames=${probe?.frames}`);
    check("notes started", (probe?.notesStarted ?? 0) >= 8, `started=${probe?.notesStarted}`);
    check("notes changed", (probe?.notesChanged ?? 0) >= 8, `changed=${probe?.notesChanged}`);
    check(
      "notes resolved",
      (probe?.notesResolved ?? 0) >= 4,
      `resolved=${probe?.notesResolved}`
    );
    check("notes ended", (probe?.notesEnded ?? 0) >= 6, `ended=${probe?.notesEnded}`);
    // `noteResolved` firing is not the same claim as the Note it carried having
    // settled; assert the delivered lifecycle, not just the event count.
    check(
      "a Note reached lifecycle `resolved`",
      probe?.sawResolvedLifecycle === true,
      `sawResolvedLifecycle=${probe?.sawResolvedLifecycle}`
    );
    // The headline 0.2 behaviour: a Note that started as a single pitch and
    // acquired `harmony` later, via `harmonyEnrichment`. A demo that only ever
    // showed final chord names would pass everything above and still be wrong.
    check(
      "a Note bloomed into a chord after it had started",
      (probe?.notesBloomed ?? 0) >= 1,
      `bloomed=${probe?.notesBloomed}`
    );
    check(
      "a correction carried its previous reading",
      (probe?.corrections ?? 0) >= 1,
      `corrections=${probe?.corrections}`
    );
    check(
      "getTimebase() reported a sample rate",
      typeof probe?.timebase?.sampleRate === "number" && probe.timebase.sampleRate > 0,
      JSON.stringify(probe?.timebase)
    );
    check("no library error surfaced", probe?.lastError == null, JSON.stringify(probe?.lastError));

    // --- the canvas really painted -----------------------------------------
    const pixels = await page.evaluate(() => {
      const canvas = document.getElementById("timeline-canvas");
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // The timeline clears to --canvas-ground (which tracks --bg). Read it
      // rather than hardcoding a triple, so a re-theme cannot silently turn
      // this check vacuous by moving the ground out from under it.
      const groundCss = getComputedStyle(document.documentElement)
        .getPropertyValue("--canvas-ground")
        .trim();
      const probe = document.createElement("canvas");
      probe.width = probe.height = 1;
      const pctx = probe.getContext("2d");
      pctx.fillStyle = groundCss || "#000000";
      pctx.fillRect(0, 0, 1, 1);
      const [gr, gg, gb] = pctx.getImageData(0, 0, 1, 1).data;

      const colours = new Set();
      let nonBackground = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (Math.abs(r - gr) > 6 || Math.abs(g - gg) > 6 || Math.abs(b - gb) > 6) nonBackground += 1;
        if (colours.size < 4096) colours.add((r << 16) | (g << 8) | b);
      }
      return {
        width,
        height,
        cssWidth: canvas.clientWidth,
        ground: [gr, gg, gb],
        nonBackground,
        total: data.length / 4,
        distinctColours: colours.size,
      };
    });

    check("canvas has a backing store", (pixels?.width ?? 0) > 0 && (pixels?.height ?? 0) > 0,
      `${pixels?.width}x${pixels?.height}`);
    check(
      "canvas is at device resolution (devicePixelRatio honoured)",
      (pixels?.width ?? 0) >= (pixels?.cssWidth ?? 0) * 1.5,
      `backing ${pixels?.width}px for ${pixels?.cssWidth}css`
    );
    const inkRatio = pixels ? pixels.nonBackground / pixels.total : 0;
    check(
      "timeline actually drew content",
      inkRatio > 0.01,
      `${(inkRatio * 100).toFixed(2)}% of pixels non-background (ground rgb(${pixels?.ground}))`
    );
    check(
      "timeline drew coloured note bars, not just gridlines",
      (pixels?.distinctColours ?? 0) > 40,
      `${pixels?.distinctColours} distinct colours`
    );

    // --- panels populated ---------------------------------------------------
    const logLines = await page.locator("#event-log .log-line").count();
    check("note log filled", logLines >= 8, `${logLines} lines`);

    const changeLines = await page.locator('#event-log .log-line[data-phase="change"]').count();
    check("note log shows revisions, not just starts and ends", changeLines >= 1,
      `${changeLines} change lines`);

    const frequencyText = await page.locator("#frequency-value").innerText();
    check("frequency readout is live", /\d/.test(frequencyText), frequencyText);

    const noteText = await page.locator("#note-name").innerText();
    check("note readout is live", noteText.trim() !== "" && noteText.trim() !== "—", noteText);

    const timebaseText = (await page.locator("#timebase-value").innerText()).trim();
    check("timebase readout is populated", /\d/.test(timebaseText), timebaseText);

    // The per-channel meters are asserted here, on the mock, because the mock is
    // the source that still supplies `PitchFrame.channelRms`. The live path's
    // version of this check is in runStereoChannelCheck.
    const mockChannels = await readChannelPanel(page);
    check(
      "per-channel meters render from PitchFrame.channelRms",
      mockChannels.count === 2 && /2 ch/.test(mockChannels.note),
      `${mockChannels.count} rows, note="${mockChannels.note}"`
    );

    // --- the hypothesis trail ----------------------------------------------
    // The most visible new capability in 0.2. Rendering it is what lets a
    // player who disagrees with the answer see what else was considered.
    //
    // Waited for rather than sampled: the panel only holds Notes that are
    // currently sounding, so a single read lands wherever the phrase happens to
    // be and would assert the score's timing rather than the UI.
    const sawTrail = await page
      .waitForFunction(
        () => document.querySelectorAll("#active-events .event-alt.trail").length > 0,
        undefined,
        { timeout: 8000 }
      )
      .then(() => true, () => false);
    check("active Notes show what was ruled out", sawTrail);

    // --- modes are gone -----------------------------------------------------
    // 0.2 deleted them outright, so a mode control reappearing is a regression,
    // not a feature. Asserted rather than merely deleted from this file.
    const modeControls = await page.locator("#mode-select").count();
    check("no mode selector survives", modeControls === 0, `${modeControls} found`);

    // --- error surface ------------------------------------------------------
    await page.goto(`${ORIGIN}/?mock=1&failWith=mic-permission-denied`, { waitUntil: "load" });
    await page.click("#listen-btn");
    await page.waitForSelector("#error-banner:not([hidden])", { timeout: 10_000 });
    const errorCode = (await page.locator("#error-code").innerText()).trim();
    const errorTitle = (await page.locator("#error-title").innerText()).trim();
    check(
      "denied mic permission shows a readable message",
      errorCode === "mic-permission-denied" && errorTitle.length > 0,
      `${errorCode} / "${errorTitle}"`
    );

    // --- the real library, against a fake input device (opt-in) -------------
    if (INCLUDE_LIVE) {
      await page.context().grantPermissions(["microphone"], { origin: ORIGIN });

      await page.goto(`${ORIGIN}/?mock=0&workletUrl=/definitely-not-here.js`, {
        waitUntil: "load",
      });
      await page.click("#listen-btn");
      await page.waitForSelector("#error-banner:not([hidden])", { timeout: 15_000 });
      const workletCode = (await page.locator("#error-code").innerText()).trim();
      check(
        "live: bad workletUrl reports `worklet-load-failed`",
        workletCode === "worklet-load-failed",
        workletCode
      );

      await page.goto(`${ORIGIN}/?mock=0`, { waitUntil: "load" });
      await page.click("#listen-btn");
      await page.waitForFunction(
        () => document.getElementById("state-pill")?.textContent === "listening",
        undefined,
        { timeout: 15_000 }
      );
      await page.waitForTimeout(4000);
      const liveProbe = await page.evaluate(() => window.__tuninatorDemo ?? null);
      check("live: real library reached `listening`", liveProbe?.state === "listening");
      check(
        "live: real library emitted pitch frames",
        (liveProbe?.frames ?? 0) > 50,
        `frames=${liveProbe?.frames}`
      );
      // The demo shares its AudioContext with the library, so `getTimebase()`
      // carries an `originContextTime` and the timeline is pinned to the audio
      // clock rather than estimating the offset from arrival times.
      check(
        "live: getTimebase() related source time to the shared AudioContext",
        typeof liveProbe?.timebase?.originContextTime === "number" &&
          liveProbe?.timebaseAnchored === true,
        `timebase=${JSON.stringify(liveProbe?.timebase)} anchored=${liveProbe?.timebaseAnchored}`
      );

      await installMediaShim(page);
      await runStereoChannelCheck(page);
      await runCombFilterCheck(page);
    }

    // --- screenshot: back to the good path, one full phrase on screen -------
    await page.goto(`${ORIGIN}/?mock=1&metronome=1`, { waitUntil: "load" });
    await page.click("#listen-btn");
    await page.waitForTimeout(OBSERVE_MS);
    const shot = path.join(root, "screenshot.png");
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`→ screenshot saved to ${shot}`);

    check(
      "no console errors",
      consoleErrors.length === 0,
      [...consoleErrors, ...badResponses].join(" | ")
    );
    check("no failed network requests", badResponses.length === 0, badResponses.join(" | "));
    check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    console.log("all smoke checks passed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
