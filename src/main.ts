/**
 * Wiring: build a `Recognizer`, pump its streams into the timeline and the
 * panels, and keep the metronome running alongside.
 *
 * Only the public API is used. The imports from the library are
 * `createRecognizer` and `RecognizerError` plus types, from the package entry
 * point.
 */

import { createRecognizer, RecognizerError } from "tuninator";
import type {
  Note,
  NoteChange,
  PitchFrame,
  Recognizer,
  RecognizerErrorCode,
  RecognizerErrorLike,
  RecognizerOptions,
  RecognizerState,
  SourceTimeMs,
  Timebase,
} from "tuninator";

import { DEFAULT_BPM, Metronome } from "./metronome.js";
import { createMockRecognizer } from "./mock-tuninator.js";
import { Timeline, WINDOW_BEATS } from "./timeline.js";
import { Ui, type SourceChoice } from "./ui.js";

// Self-hosted via @fontsource rather than a Google Fonts <link>: keeps the
// demo working offline and makes the smoke screenshot deterministic. The two
// faces are the ones the cyberpunk-ui skill's source video names.
import "@fontsource/roboto-mono/latin-400.css";
import "@fontsource/roboto-mono/latin-500.css";
import "@fontsource/vt323/latin-400.css";
import "./styles.css";

/**
 * Where vite.config.ts drops the library's built worklet.
 *
 * Built through `import.meta.env.BASE_URL`, not a bare "/assets/...", because
 * a GitHub Pages project site serves from a subpath (e.g. "/tuninator-example/").
 * A hardcoded root-absolute path 404s there even though it works in local dev,
 * where BASE_URL is just "/".
 */
const WORKLET_URL = `${import.meta.env.BASE_URL}assets/tuninator-worklet.js`;

const ERROR_CODES: ReadonlySet<string> = new Set<RecognizerErrorCode>([
  "mic-unavailable",
  "mic-permission-denied",
  "audio-context-failed",
  "worklet-unavailable",
  "worklet-load-failed",
  "engine-load-failed",
  "already-disposed",
  "unknown",
]);

/* -------------------------------------------------------------------------- */
/* Wall clock                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Converts `SourceTimeMs` into `performance.now()` space.
 *
 * The library's clock is *source* time: milliseconds of audio since the first
 * processed sample, epoch 0, derived from a sample count and nothing else. The
 * timeline draws relative to `performance.now()`, so the two need relating.
 *
 * There are two ways to do it, and this uses the better one when it can:
 *
 *  - **Anchored.** `getTimebase().originContextTime` is `AudioContext.currentTime`
 *    at source time 0. Because the demo hands the recognizer the same context
 *    the metronome runs on, that value can be read against this page's own
 *    clock — `getOutputTimestamp()` gives the two together — and the offset is
 *    then exact rather than inferred.
 *  - **Estimated.** With no shared context (the mock has none), the smallest
 *    observed `wall - source` is the least-delayed sample and therefore the best
 *    alignment estimate; a slow relaxation term keeps it from sticking to an
 *    outlier if the clocks drift.
 *
 * Either way it MUST be reset on every `start()`: source time restarts at 0 each
 * time while `performance.now()` does not, so a stale minimum from a previous
 * run would place the whole timeline in the distant past.
 */
class WallClock {
  /** `performance.now()` at source time 0. */
  #offset: number | null = null;
  #anchored = false;

  /**
   * Pin the offset exactly, from the recognizer's own timebase.
   *
   * Returns false when there is nothing to pin it to — no timebase, no
   * `originContextTime` (an offline clock), or no context to read against.
   */
  anchor(timebase: Timebase | null, context: AudioContext | null): boolean {
    if (!timebase || timebase.originContextTime === undefined || !context) return false;

    // `getOutputTimestamp()` exists precisely to sample the audio clock and the
    // page clock as one pair; reading the two separately is a fallback.
    const stamp = context.getOutputTimestamp?.();
    const usable =
      stamp !== undefined &&
      Number.isFinite(stamp.contextTime) &&
      Number.isFinite(stamp.performanceTime) &&
      (stamp.contextTime ?? 0) > 0;
    const contextTime = usable ? (stamp.contextTime as number) : context.currentTime;
    const wall = usable ? (stamp.performanceTime as number) : performance.now();

    this.#offset = wall - (contextTime - timebase.originContextTime) * 1000;
    this.#anchored = true;
    return true;
  }

  observe(sourceMs: SourceTimeMs): void {
    if (this.#anchored || !Number.isFinite(sourceMs)) return;
    const sample = performance.now() - sourceMs;
    if (this.#offset === null || sample < this.#offset) {
      this.#offset = sample;
      return;
    }
    this.#offset += (sample - this.#offset) * 0.0008;
  }

  toWall(sourceMs: SourceTimeMs): number {
    return sourceMs + (this.#offset ?? performance.now());
  }

  get anchored(): boolean {
    return this.#anchored;
  }

  reset(): void {
    this.#offset = null;
    this.#anchored = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Error normalisation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Everything the library rejects or emits is already a `RecognizerError`, but
 * the demo also funnels `window.onerror` and stray rejections through the same
 * banner, so anything else is wrapped here. The UI therefore always has a code
 * and a readable message, never a raw throw.
 */
function toRecognizerError(cause: unknown): RecognizerError {
  if (cause instanceof RecognizerError) return cause;

  if (typeof DOMException !== "undefined" && cause instanceof DOMException) {
    if (cause.name === "NotAllowedError" || cause.name === "SecurityError") {
      return new RecognizerError("mic-permission-denied", cause.message || cause.name, cause);
    }
    if (cause.name === "NotFoundError" || cause.name === "OverconstrainedError") {
      return new RecognizerError("mic-unavailable", cause.message || cause.name, cause);
    }
  }

  // A thrown object carrying a known code but not extending Error — the shape
  // 0.1 used. Preserved so a mixed checkout still reports something useful.
  if (typeof cause === "object" && cause !== null) {
    const candidate = cause as { code?: unknown; message?: unknown };
    if (typeof candidate.code === "string" && ERROR_CODES.has(candidate.code)) {
      return new RecognizerError(
        candidate.code as RecognizerErrorCode,
        typeof candidate.message === "string" ? candidate.message : candidate.code,
        cause
      );
    }
  }

  if (cause instanceof Error) {
    return new RecognizerError("unknown", cause.message || String(cause), cause);
  }
  return new RecognizerError("unknown", String(cause), cause);
}

/* -------------------------------------------------------------------------- */
/* Audio context                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The one `AudioContext` the page owns, handed to both the metronome and the
 * library.
 *
 * Constructed at load, which leaves it `suspended` under an autoplay policy;
 * both consumers `resume()` it from inside a user gesture, so there is nothing
 * to defer. A browser with no Web Audio at all returns null and each side falls
 * back to making its own — the demo still runs, it just cannot align the two
 * clocks exactly.
 */
function createSharedContext(): AudioContext | null {
  const Ctor =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* URL configuration                                                           */
/* -------------------------------------------------------------------------- */

type Settings = {
  source: SourceChoice;
  workletUrl: string;
  failWith: RecognizerErrorCode | null;
  autostart: boolean;
  metronome: boolean;
  /** `input.channels`: which input channel(s) the library should analyse. */
  channels: "auto" | "sum" | number;
};

function readSettings(): Settings {
  const params = new URLSearchParams(window.location.search);

  const mockParam = params.get("mock");
  const source: SourceChoice =
    mockParam === null
      ? "auto"
      : mockParam === "0" || mockParam === "false"
        ? "live"
        : "mock";

  const failParam = params.get("failWith");
  const failWith =
    failParam && ERROR_CODES.has(failParam) ? (failParam as RecognizerErrorCode) : null;

  const truthy = (value: string | null): boolean =>
    value !== null && value !== "0" && value !== "false";

  return {
    source,
    workletUrl: params.get("workletUrl") ?? WORKLET_URL,
    failWith,
    autostart: truthy(params.get("autostart")),
    metronome: truthy(params.get("metronome")),
    channels: readChannels(params.get("channels")),
  };
}

/**
 * `?channels=auto|sum|<index>`.
 *
 * The library default is `auto` (analyse the loudest channel). `sum` is exposed
 * here because it is the only way to *see* the difference: a mic and a DI of one
 * guitar, summed, comb-filter into an octave error, and a demo that can only
 * ever run the good path cannot demonstrate that.
 */
function readChannels(value: string | null): "auto" | "sum" | number {
  if (value === null || value === "auto") return "auto";
  if (value === "sum") return "sum";
  const index = Number.parseInt(value, 10);
  return Number.isInteger(index) && index >= 0 ? index : "auto";
}

/* -------------------------------------------------------------------------- */
/* App                                                                         */
/* -------------------------------------------------------------------------- */

/** Counters the headless smoke test reads to assert the streams really flowed. */
type DemoProbe = {
  frames: number;
  notesStarted: number;
  notesChanged: number;
  notesResolved: number;
  notesEnded: number;
  /** Notes that acquired `harmony` *after* they had already started — a bloom. */
  notesBloomed: number;
  /** `pitchCorrection` / `harmonyCorrection` changes seen. */
  corrections: number;
  /** True once a Note was delivered with `lifecycle === "resolved"`. */
  sawResolvedLifecycle: boolean;
  source: "mock" | "live";
  state: RecognizerState;
  lastError: { code: string; message: string } | null;
  /** `getTimebase()` as of the last start. Null until `start()` resolves. */
  timebase: Timebase | null;
  /** True when the timeline is pinned to the audio clock rather than estimated. */
  timebaseAnchored: boolean;
  /** Last `PitchFrame.selectedChannel`: index, null for summed, undefined for none. */
  selectedChannel: number | null | undefined;
  /** Last `PitchFrame.channelRms`. */
  channelRms: number[] | undefined;
};

/** Changes worth a line in the log. The rest would drown it. */
const LOGGED_CHANGES: ReadonlySet<NoteChange["type"]> = new Set([
  "pitchCorrection",
  "harmonyCorrection",
  "harmonyEnrichment",
  "structuralRevision",
]);

class App {
  #settings: Settings;
  #ui: Ui;
  #timeline: Timeline;
  #metronome: Metronome;
  #wallClock = new WallClock();

  #recognizer: Recognizer | null = null;
  /**
   * One `AudioContext` for the whole page, shared with the library.
   *
   * 0.2 added `RecognizerOptions.audioContext` and promises never to close a
   * context it did not create, which is what makes this safe. It is also what
   * makes `getTimebase().originContextTime` usable: the metronome's clicks and
   * the recognizer's Notes are now on one audio clock rather than two.
   */
  #audioContext: AudioContext | null = null;
  #unsubscribes: Array<() => void> = [];
  #effectiveSource: "mock" | "live" = "mock";
  #listening = false;
  #busy = false;

  /** Latest source time seen on any stream. Stands in for "now" in the Note model. */
  #sourceNowMs: SourceTimeMs = 0;
  /** Note ids that were delivered without `harmony`, so a bloom is detectable. */
  #pitchOnlyNotes = new Set<string>();

  #probe: DemoProbe;

  constructor(settings: Settings) {
    this.#settings = settings;

    this.#ui = new Ui({
      onToggleListen: () => void this.#toggleListen(),
      onSourceChange: (source) => void this.#setSource(source),
      onToggleMetronome: () => void this.#toggleMetronome(),
      onMuteChange: (muted) => this.#metronome.setMuted(muted),
    });

    this.#timeline = new Timeline(this.#ui.canvas, {
      toWall: (sourceMs) => this.#wallClock.toWall(sourceMs),
    });

    this.#metronome = new Metronome(DEFAULT_BPM);
    this.#audioContext = createSharedContext();
    if (this.#audioContext) this.#metronome.useContext(this.#audioContext);
    this.#metronome.onChange((status) => {
      this.#ui.setMetronome(status, DEFAULT_BPM);
      this.#timeline.setGrid(this.#metronome.getGrid());
    });

    this.#probe = {
      frames: 0,
      notesStarted: 0,
      notesChanged: 0,
      notesResolved: 0,
      notesEnded: 0,
      notesBloomed: 0,
      corrections: 0,
      sawResolvedLifecycle: false,
      source: "mock",
      state: "idle",
      lastError: null,
      timebase: null,
      timebaseAnchored: false,
      selectedChannel: undefined,
      channelRms: undefined,
    };

    this.#timeline.setGrid(this.#metronome.getGrid());
    this.#timeline.start();

    this.#ui.setState("idle");
    this.#ui.setListening(false);
    this.#ui.setMetronome({ running: false, message: null }, DEFAULT_BPM);
    this.#ui.setStatus(
      `Ready. ${WINDOW_BEATS} beats of history at ${DEFAULT_BPM} bpm ` +
        `= ${((WINDOW_BEATS * 60_000) / DEFAULT_BPM / 1000).toFixed(2)}s on screen.`
    );

    this.#installGlobalErrorHandlers();
    this.#installUnloadHandler();
    this.#build(settings.source);

    if (settings.metronome) void this.#metronome.start();
    if (settings.autostart) void this.#toggleListen();
  }

  get probe(): DemoProbe {
    return this.#probe;
  }

  /* ---- construction ---- */

  #baseOptions(): RecognizerOptions {
    return {
      // Caller-owned, and the library never closes a context it did not create.
      // Sharing it is what puts the metronome and the analysis on one clock.
      ...(this.#audioContext ? { audioContext: this.#audioContext } : {}),
      workletUrl: this.#settings.workletUrl,
      input: { channels: this.#settings.channels },
      // 0.2 folds the old `analysis` and `tracking` blocks into one `engine`.
      engine: { minFrequencyHz: 70, maxFrequencyHz: 1400 },
      // Both streams are opt-in in 0.2. The tuner readout is the pitch stream,
      // and the timeline draws a bend as a curve rather than a step, so both
      // are asked for explicitly.
      diagnostics: { pitchFrames: true, contour: true },
    };
  }

  /**
   * `auto` prefers the real library and falls back to the mock if it cannot be
   * constructed at all. `createRecognizer` does no work until `start()`, so in
   * practice this only catches a genuinely broken checkout — but the fallback
   * is what keeps the deployed demo usable when the library changes under it.
   */
  #build(choice: SourceChoice): void {
    this.#teardown();

    let instance: Recognizer | null = null;
    let note: string | undefined;

    if (choice !== "mock") {
      try {
        instance = createRecognizer(this.#baseOptions());
        this.#effectiveSource = "live";
      } catch (cause) {
        const error = toRecognizerError(cause);
        if (choice === "live") {
          this.#ui.setError(error);
          this.#ui.logNote(`live source unavailable: ${error.message}`);
        } else {
          note = `The real library could not be constructed (${error.message}); using the mock.`;
          this.#ui.logNote(note);
          this.#ui.setStatus(note);
        }
        instance = null;
      }
    }

    if (!instance) {
      instance = createMockRecognizer({
        ...this.#baseOptions(),
        ...(this.#settings.failWith ? { failWith: this.#settings.failWith } : {}),
      });
      this.#effectiveSource = "mock";
    }

    this.#recognizer = instance;
    this.#probe.source = this.#effectiveSource;
    this.#ui.setSource(choice, this.#effectiveSource, note);
    this.#ui.setState(instance.getState());
    this.#timeline.setHint(
      this.#effectiveSource === "mock"
        ? "Press Start — the mock plays a 16-beat phrase."
        : "Press Start and play something."
    );
    this.#subscribe(instance);
  }

  #subscribe(recognizer: Recognizer): void {
    const add = (unsubscribe: () => void): void => {
      this.#unsubscribes.push(unsubscribe);
    };

    add(
      recognizer.on("stateChange", (state: RecognizerState) => {
        this.#probe.state = state;
        this.#ui.setState(state);
        this.#listening = state === "listening";
        this.#ui.setListening(this.#listening, this.#busy);
        // Source time restarts at 0 on every start, so the wall-clock offset
        // measured during the previous run is worse than having none.
        if (state === "starting") this.#resetClock();
        if (state === "listening") this.#reportTimebase(recognizer);
        if (state !== "error") this.#ui.setError(null);
      })
    );

    add(recognizer.on("status", (message: string) => this.#ui.setStatus(message)));

    add(
      recognizer.on("error", (error: RecognizerErrorLike) => {
        this.#probe.lastError = { code: error.code, message: error.message };
        this.#ui.setError(error);
        this.#ui.logNote(`error (${error.code}): ${error.message}`);
      })
    );

    add(
      recognizer.on("pitchFrame", (frame: PitchFrame) => {
        this.#observe(frame.timestamp);
        this.#probe.frames += 1;
        this.#probe.selectedChannel = frame.selectedChannel;
        this.#probe.channelRms = frame.channelRms;
        this.#ui.setFrame(frame);
      })
    );

    add(
      recognizer.on("noteStarted", (note: Note) => {
        this.#observe(note.startTime);
        this.#probe.notesStarted += 1;
        if (!note.harmony) this.#pitchOnlyNotes.add(note.id);
        this.#timeline.track(note, note.startTime);
        this.#ui.logStarted(note);
        this.#publishActive(recognizer);
      })
    );

    add(
      recognizer.on("noteChanged", (note: Note, change: NoteChange) => {
        this.#observe(change.at);
        this.#probe.notesChanged += 1;
        if (change.type === "pitchCorrection" || change.type === "harmonyCorrection") {
          this.#probe.corrections += 1;
        }
        // A bloom is a Note that started as a single pitch and later acquired a
        // chord identity. It is the behaviour the 0.2 model exists for, so it
        // is called out rather than folded into the generic change log.
        if (note.harmony && this.#pitchOnlyNotes.delete(note.id)) {
          this.#probe.notesBloomed += 1;
          this.#ui.logBloom(note, change);
        } else if (LOGGED_CHANGES.has(change.type)) {
          this.#ui.logChange(note, change);
        }
        this.#timeline.track(note, change.at);
        this.#publishActive(recognizer);
      })
    );

    add(
      recognizer.on("noteResolved", (note: Note) => {
        this.#probe.notesResolved += 1;
        if (note.lifecycle === "resolved") this.#probe.sawResolvedLifecycle = true;
        this.#timeline.track(note, this.#sourceNowMs);
        this.#ui.logResolved(note);
        this.#publishActive(recognizer);
      })
    );

    add(
      recognizer.on("noteEnded", (note: Note) => {
        this.#observe(note.endTime ?? note.startTime);
        this.#probe.notesEnded += 1;
        this.#pitchOnlyNotes.delete(note.id);
        this.#timeline.track(note, note.endTime ?? this.#sourceNowMs);
        this.#ui.logEnded(note);
        this.#publishActive(recognizer);
      })
    );
  }

  #publishActive(recognizer: Recognizer): void {
    // Genuinely plural in 0.2: a restrum over a still-ringing chord is two
    // Notes at once, so this is a list keyed by id rather than "the current one".
    this.#ui.setActiveNotes(recognizer.getActiveNotes(), this.#sourceNowMs);
  }

  #observe(sourceMs: SourceTimeMs): void {
    if (!Number.isFinite(sourceMs)) return;
    this.#wallClock.observe(sourceMs);
    if (sourceMs > this.#sourceNowMs) this.#sourceNowMs = sourceMs;
  }

  #resetClock(): void {
    this.#wallClock.reset();
    this.#sourceNowMs = 0;
    this.#pitchOnlyNotes.clear();
  }

  /**
   * `getTimebase()` is new in 0.2 and is the only thing relating source time to
   * the host's own clock. Surfacing it is the point of the demo: an integrator
   * lining Notes up against their own scheduled audio needs exactly this.
   */
  #reportTimebase(recognizer: Recognizer): void {
    const timebase = recognizer.getTimebase();
    this.#probe.timebase = timebase;
    this.#ui.setTimebase(timebase);
    // Pin the timeline to the audio clock if the recognizer gave us an origin
    // on a context we can read. Otherwise the estimator keeps running.
    this.#wallClock.anchor(timebase, this.#audioContext);
    this.#probe.timebaseAnchored = this.#wallClock.anchored;
    if (timebase) {
      const origin =
        timebase.originContextTime === undefined
          ? "no context origin (offline clock)"
          : `origin ctx ${timebase.originContextTime.toFixed(3)}s`;
      const alignment = this.#wallClock.anchored ? "anchored" : "estimated";
      this.#ui.logNote(`timebase: ${timebase.sampleRate}Hz · ${origin} · ${alignment}`);
    }
  }

  #teardown(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes = [];
    // The instance is being discarded, so release the microphone and the
    // worklet with it rather than leaving them held by an unreachable object.
    const going = this.#recognizer;
    this.#recognizer = null;
    if (going) void going.dispose().catch(() => {});
    this.#listening = false;
    this.#resetClock();
    this.#ui.setTimebase(null);
    this.#probe.timebase = null;
    this.#probe.timebaseAnchored = false;
  }

  /* ---- transport ---- */

  async #toggleListen(): Promise<void> {
    const recognizer = this.#recognizer;
    if (!recognizer || this.#busy) return;

    if (this.#listening || recognizer.getState() === "listening") {
      this.#busy = true;
      this.#ui.setListening(true, true);
      try {
        // Async in 0.2, and awaiting it is what guarantees every Note still
        // sounding gets its `noteEnded` instead of being dropped mid-flight.
        await recognizer.stop();
      } catch (cause) {
        this.#ui.setError(toRecognizerError(cause));
      } finally {
        this.#busy = false;
        this.#listening = false;
        this.#ui.setListening(false, false);
        this.#publishActive(recognizer);
      }
      return;
    }

    this.#busy = true;
    this.#ui.setListening(false, true);
    this.#ui.setError(null);
    try {
      // A user gesture is on the stack here, so the metronome's AudioContext
      // (and the library's) can legally start.
      await recognizer.start();
      this.#listening = recognizer.getState() === "listening";
    } catch (cause) {
      const error = toRecognizerError(cause);
      this.#probe.lastError = { code: error.code, message: error.message };
      this.#ui.setError(error);
      this.#ui.setStatus(`Could not start: ${error.message}`);
      this.#listening = false;
    } finally {
      this.#busy = false;
      this.#ui.setListening(this.#listening, false);
    }
  }

  async #setSource(choice: SourceChoice): Promise<void> {
    const wasListening = this.#listening;
    this.#settings.source = choice;
    this.#ui.setError(null);
    this.#timeline.clear();
    this.#ui.clearLog();
    this.#ui.setActiveNotes([], 0);
    this.#build(choice);
    if (wasListening) await this.#toggleListen();
  }

  async #toggleMetronome(): Promise<void> {
    await this.#metronome.toggle();
    this.#timeline.setGrid(this.#metronome.getGrid());
  }

  /* ---- safety net ---- */

  #installGlobalErrorHandlers(): void {
    window.addEventListener("error", (event) => {
      this.#ui.setError(toRecognizerError(event.error ?? event.message));
    });
    window.addEventListener("unhandledrejection", (event) => {
      this.#ui.setError(toRecognizerError(event.reason));
      event.preventDefault();
    });
  }

  /**
   * `dispose()` is new in 0.2 and is the only thing that releases the
   * microphone. Without this the recording indicator can outlive the page in a
   * bfcache'd tab. `pagehide` fires in cases `beforeunload` does not.
   */
  #installUnloadHandler(): void {
    window.addEventListener("pagehide", (event) => {
      void this.#recognizer?.dispose().catch(() => {});
      // The recognizer never closes a context it did not create, so the page
      // closes its own -- but only when the page is really going away.
      // `persisted` means bfcache, where the document may come back.
      if (!event.persisted) void this.#audioContext?.close().catch(() => {});
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

declare global {
  interface Window {
    __tuninatorDemo?: DemoProbe;
  }
}

function boot(): void {
  try {
    const app = new App(readSettings());
    window.__tuninatorDemo = app.probe;
  } catch (cause) {
    // The UI itself failed to construct; there is no banner to render into.
    const error = toRecognizerError(cause);
    const fallback = document.createElement("pre");
    // Literal rather than tokenised on purpose: this path runs when the UI
    // failed to construct, which may mean the stylesheet never applied, so it
    // cannot rely on var(--bad). Kept on-palette by hand.
    fallback.style.cssText =
      "padding:24px;color:#ff4500;background:#000;font:13px ui-monospace,monospace";
    fallback.textContent = `Demo failed to start (${error.code}): ${error.message}`;
    document.body.prepend(fallback);
    console.error(cause);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
