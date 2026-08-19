/**
 * A synthetic `Recognizer`.
 *
 * It plays a fixed 16-beat guitar phrase at 90bpm and emits the same streams
 * the real 0.2 library promises: `noteStarted` → `noteChanged` → `noteResolved`
 * → `noteEnded`, plus the opt-in `pitchFrame` diagnostic. No microphone, no
 * permission prompt, no audio hardware — which is what makes the headless smoke
 * suite deterministic.
 *
 * It is a real implementation, not a stub, and it deliberately exercises the
 * paths a demo would otherwise never see:
 *
 *   - a Note that **blooms**: it starts as a single pitch and acquires
 *     `harmony` part-way through, delivered as `harmonyEnrichment`,
 *   - a Note the recognizer gets **wrong first**, corrected via
 *     `pitchCorrection` carrying `change.previous`,
 *   - a chord it can identify but will not **name** (`harmony` present,
 *     `chordName` undefined) — honest abstention,
 *   - a **bend** with `note.bend` populated,
 *   - **overlapping** Notes, because `getActiveNotes()` is genuinely plural,
 *   - non-empty `hypotheses.active` and `hypotheses.trail`, so the
 *     alternatives and ruled-out UI always has something to render.
 *
 * It implements the PUBLIC `Recognizer` type and imports only the package entry
 * point.
 */

import { RecognizerError } from "tuninator";

import { clamp01, hzToMidi, midiToHz, noteNameOf, octaveOf, pitchClassOf } from "./pitch.js";
import type {
  DetectedPitch,
  Hypothesis,
  HypothesisKind,
  Note,
  NoteChange,
  NoteChangeType,
  NoteLifecycle,
  PitchClass,
  PitchFrame,
  PitchNote,
  Recognizer,
  RecognizerErrorCode,
  RecognizerEventMap,
  RecognizerEventName,
  RecognizerOptions,
  RecognizerState,
  SourceTimeMs,
  Timebase,
} from "tuninator";

/* -------------------------------------------------------------------------- */
/* Note helpers (synthesis-side only -- the real library derives these itself)  */
/* -------------------------------------------------------------------------- */

/** Build the `PitchNote` the library would report for a detected frequency. */
function nearestNote(frequencyHz: number): PitchNote {
  const exact = hzToMidi(frequencyHz);
  const midi = Math.round(exact);
  let cents = (exact - midi) * 100;
  // Range is documented as (-50, +50].
  if (cents <= -50) cents += 100;
  if (cents > 50) cents -= 100;
  return {
    midi,
    name: noteNameOf(midi),
    pitchClass: pitchClassOf(midi),
    octave: octaveOf(midi),
    frequencyHz,
    cents,
  };
}

/**
 * `DetectedPitch` requires midi/name/pitchClass/octave. The old `EventPitch`
 * had every one of them optional, which is how a chord's voicing used to decay
 * into a set of pitch classes; there is no equivalent hole to fall into here.
 */
function detectedPitch(
  midi: number,
  role: DetectedPitch["role"],
  confidence: number,
  centsOffset = 0,
  salience?: number
): DetectedPitch {
  const pitch: DetectedPitch = {
    midi,
    name: noteNameOf(midi),
    pitchClass: pitchClassOf(midi),
    octave: octaveOf(midi),
    frequencyHz: midiToHz(midi + centsOffset / 100),
    centsOffset,
    role,
    confidence: clamp01(confidence),
  };
  if (salience !== undefined) pitch.salience = clamp01(salience);
  return pitch;
}

/* -------------------------------------------------------------------------- */
/* The score                                                                   */
/* -------------------------------------------------------------------------- */

const BPM = 90;
const BEAT_MS = 60_000 / BPM;

type Alternative = { kind: HypothesisKind; label: string; confidence: number };

type ScoreEntry = {
  /** Beat offset from the top of the 16-beat loop. */
  beat: number;
  /** Length in beats. */
  beats: number;
  /** MIDI numbers, lowest first. A chord's full voicing. */
  midi: number[];
  /** Index into `midi` carrying the melody while the Note is a single pitch. */
  primaryIndex?: number;

  /**
   * The chord this Note blooms into, and how far through it does so.
   *
   * Until then the Note has `pitch` and no `harmony` at all, exactly as a real
   * one does: the deep lane has not caught up yet. `chordName: undefined` is a
   * chord the recognizer identifies but declines to name.
   */
  bloom?: {
    at: number;
    root: PitchClass;
    quality?: string;
    chordName?: string;
    intervals?: string[];
  };

  /** The Note is first reported as this, then corrected to its real pitch. */
  misheardAs?: { midi: number; at: number };

  /** Cents reached at the end of the Note, if it is bent. */
  bendCents?: number;
  /** Fraction (0..1) into the Note where the bend begins. */
  bendFrom?: number;

  /** Runner-up interpretations the recognizer entertains. */
  alternatives?: Alternative[];
};

/**
 * Sixteen beats -- exactly one full timeline window -- then it loops.
 * An open-position phrase in E minor: a lick, a bent B, and three chords.
 */
const SCORE: readonly ScoreEntry[] = [
  { beat: 0.0, beats: 0.9, midi: [64] },
  { beat: 1.0, beats: 0.7, midi: [67] },
  {
    // Heard an octave low at first. The correction is the point: 0.2 says so
    // with `pitchCorrection` and `change.previous` rather than silently
    // swapping the label.
    //
    // No explicit alternatives: the misheard reading is already this Note's
    // leading hypothesis, and listing it again as a rival would put the same
    // label in both `active` and `trail` once the correction supersedes it.
    // The default octave rival below is generated from the misheard pitch,
    // which is what an octave-confused detector would actually entertain.
    beat: 1.75,
    beats: 0.7,
    midi: [69],
    misheardAs: { midi: 57, at: 0.34 },
  },
  {
    beat: 2.5,
    beats: 1.4,
    midi: [71],
    bendCents: 200,
    bendFrom: 0.45,
    alternatives: [{ kind: "bend", label: "bend +2st", confidence: 0.61 }],
  },
  { beat: 4.0, beats: 0.45, midi: [69] },
  { beat: 4.5, beats: 0.45, midi: [67] },
  {
    // Starts life as a single E3 and blooms into Em.
    beat: 5.0,
    beats: 1.9,
    midi: [52, 55, 59, 64],
    bloom: { at: 0.3, root: "E", quality: "min", chordName: "Em", intervals: ["1", "b3", "5"] },
    alternatives: [
      { kind: "harmony", label: "G6", confidence: 0.31 },
      { kind: "harmony", label: "E5", confidence: 0.18 },
    ],
  },
  { beat: 7.0, beats: 0.9, midi: [62] },
  { beat: 8.0, beats: 0.7, midi: [64] },
  { beat: 8.75, beats: 0.7, midi: [67] },
  { beat: 9.5, beats: 0.45, midi: [69] },
  {
    // Rings on through beat 12, so it overlaps the B3 below: two active Notes
    // at once, which `getActiveEvents()` could not represent in 0.1.
    beat: 10.0,
    beats: 2.6,
    midi: [48, 52, 55, 60],
    bloom: { at: 0.28, root: "C", quality: "maj", chordName: "C", intervals: ["1", "3", "5"] },
    alternatives: [{ kind: "harmony", label: "Am7", confidence: 0.27 }],
  },
  { beat: 12.0, beats: 0.7, midi: [59] },
  { beat: 12.75, beats: 0.7, midi: [57] },
  { beat: 13.5, beats: 0.45, midi: [55] },
  {
    // A chord it can hear but will not name: `harmony` present, `chordName`
    // absent. The UI must render that as "…", never as a guess.
    beat: 14.0,
    beats: 1.9,
    midi: [43, 47, 50, 55],
    bloom: { at: 0.32, root: "G" },
    alternatives: [
      { kind: "harmony", label: "G", confidence: 0.44 },
      { kind: "harmony", label: "G5", confidence: 0.41 },
    ],
  },
];

const LOOP_BEATS = 16;
const LOOP_MS = LOOP_BEATS * BEAT_MS;

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export type MockRecognizerOptions = RecognizerOptions & {
  /** Make `start()` reject with this code, to exercise the error UI. */
  failWith?: RecognizerErrorCode;
  /** Milliseconds `start()` spends in the `starting` state. */
  startupMs?: number;
};

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

/** 128 samples x 4 quanta at 44.1kHz -- the library's default-ish hop. */
const HOP_MS = (128 * 4 * 1000) / 44_100;
const SAMPLE_RATE = 44_100;
const CHANGE_INTERVAL_MS = 90;
/** Fraction of a Note's length after which its answer is treated as settled. */
const RESOLVE_AT = 0.72;
/** Never emit more than this many hops in one tick, after a tab-throttle stall. */
const MAX_HOPS_PER_TICK = 24;

const ERROR_MESSAGES: Record<RecognizerErrorCode, string> = {
  "mic-unavailable": "No microphone input device was found.",
  "mic-permission-denied": "Microphone permission was denied.",
  "audio-context-failed": "The browser refused to create an AudioContext.",
  "worklet-unavailable": "This browser does not support AudioWorklet.",
  "worklet-load-failed": "The tuninator worklet asset could not be loaded.",
  "engine-load-failed": "The recognition engine could not be loaded.",
  "already-disposed": "This recognizer has been disposed.",
  unknown: "An unknown error occurred.",
};

/** Arguments per event name, so the emit side stays type-safe. */
type EventArgs = {
  [E in RecognizerEventName]: Parameters<RecognizerEventMap[E]>;
};

/** One Note's mutable interior. `snapshot()` is what handlers ever see. */
type LiveNote = {
  entry: ScoreEntry;
  id: string;
  startTime: SourceTimeMs;
  /** Scheduled end, in source time. */
  endsAt: SourceTimeMs;
  endTime: SourceTimeMs | null;
  lifecycle: NoteLifecycle;
  revisionNumber: number;
  lastChangeType: NoteChangeType | null;
  lastChangeAt: SourceTimeMs;
  /** The pitch currently believed, which the correction moves. */
  midi: number;
  bendCents: number;
  peakBendCents: number;
  bloomed: boolean;
  corrected: boolean;
  resolved: boolean;
  /** The early octave/rival prune has happened. */
  pruned: boolean;
  confidence: number;
  amplitude: { rms: number; peak: number };
  origin: DetectedPitch;
  active: Hypothesis[];
  trail: Hypothesis[];
};

class MockRecognizer implements Recognizer {
  #state: RecognizerState = "idle";
  #options: MockRecognizerOptions;
  #disposed = false;

  #handlers = new Map<RecognizerEventName, Set<(...args: never[]) => void>>();

  #timer: ReturnType<typeof setInterval> | null = null;
  /** `performance.now()` at source time 0. Source time is derived from it. */
  #originWallMs = 0;
  /** Source time of the last hop already emitted. Starts at 0, every run. */
  #cursorMs: SourceTimeMs = 0;
  #timebase: Timebase | null = null;
  #noteSeq = 0;
  #hypothesisSeq = 0;
  #live = new Map<string, LiveNote>();
  /** Recently ended Notes, so `getNote(id)` can still answer for them. */
  #recent = new Map<string, Note>();
  /**
   * Score slots already started, keyed by loop iteration.
   *
   * The lookback below consults only the current iteration and the one before
   * it, so anything older can never be read again and is dropped. Keyed by
   * iteration rather than by a flat `iteration:beat` string precisely so that
   * dropping a whole stale iteration is one delete instead of a scan -- the
   * flat map had no expiry at all and grew for as long as the mock ran.
   */
  #startedSlots = new Map<number, Set<number>>();

  constructor(options: MockRecognizerOptions = {}) {
    this.#options = options;
  }

  /* ---- public surface ---- */

  async start(): Promise<void> {
    if (this.#disposed) {
      throw new RecognizerError("already-disposed", "this recognizer has been disposed");
    }
    if (this.#state === "listening" || this.#state === "starting") return;

    this.#setState("starting");
    this.#emit("status", "mock: warming up synthetic input…");
    await delay(this.#options.startupMs ?? 140);

    const failWith = this.#options.failWith;
    if (failWith) {
      const error = new RecognizerError(
        failWith,
        `${ERROR_MESSAGES[failWith]} (simulated by the mock)`
      );
      this.#setState("error");
      this.#emit("error", error);
      throw error;
    }

    // Source time is milliseconds of audio since the first processed sample, so
    // it restarts at 0 on every start. It is NOT a wall clock and NOT
    // AudioContext time.
    this.#originWallMs = performance.now();
    this.#cursorMs = 0;
    this.#timebase = { sampleRate: SAMPLE_RATE };
    this.#setState("listening");
    this.#emit("status", `mock: playing a 16-beat phrase at ${BPM}bpm`);
    this.#timer = setInterval(() => this.#tick(), 16);
  }

  /**
   * Async, and it flushes: every Note still sounding gets its `noteEnded`
   * before this resolves. The 0.1 synchronous `stop()` dropped them.
   */
  async stop(): Promise<void> {
    if (this.#state === "idle") return;
    this.#setState("stopping");
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    for (const live of [...this.#live.values()]) this.#endNote(live, this.#cursorMs);
    this.#live.clear();
    this.#startedSlots.clear();
    this.#timebase = null;
    this.#emit("status", "mock: stopped");
    this.#setState("idle");
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.stop();
    this.#disposed = true;
    this.#handlers.clear();
  }

  getState(): RecognizerState {
    return this.#state;
  }

  getActiveNotes(): Note[] {
    return [...this.#live.values()].map((live) => this.#snapshot(live));
  }

  getNote(id: string): Note | undefined {
    const live = this.#live.get(id);
    if (live) return this.#snapshot(live);
    return this.#recent.get(id);
  }

  getTimebase(): Timebase | null {
    return this.#timebase;
  }

  on<E extends RecognizerEventName>(
    eventName: E,
    handler: RecognizerEventMap[E]
  ): () => void {
    let set = this.#handlers.get(eventName);
    if (!set) {
      set = new Set();
      this.#handlers.set(eventName, set);
    }
    const fn = handler as unknown as (...args: never[]) => void;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /* ---- internals ---- */

  #emit<E extends RecognizerEventName>(eventName: E, ...args: EventArgs[E]): void {
    const set = this.#handlers.get(eventName);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch (cause) {
        console.error(`mock-tuninator: handler for "${eventName}" threw`, cause);
      }
    }
  }

  #setState(state: RecognizerState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#emit("stateChange", state);
  }

  #tick(): void {
    const elapsed = performance.now() - this.#originWallMs;

    // After a long stall (backgrounded tab) skip ahead rather than firing a
    // burst of stale frames -- a real detector would have dropped them too.
    if (elapsed - this.#cursorMs > MAX_HOPS_PER_TICK * HOP_MS) {
      this.#cursorMs = elapsed - HOP_MS;
    }

    let hops = 0;
    while (this.#cursorMs + HOP_MS <= elapsed && hops < MAX_HOPS_PER_TICK) {
      this.#cursorMs += HOP_MS;
      hops += 1;
      this.#step(this.#cursorMs);
    }
  }

  /** Advance the simulation to one hop boundary. */
  #step(t: SourceTimeMs): void {
    const iteration = Math.floor(t / LOOP_MS);
    const loopMs = t - iteration * LOOP_MS;

    this.#syncNotes(t, iteration);

    // The continuous stream is opt-in in 0.2, so honour that: a consumer that
    // never asked for `pitchFrames` must never receive one.
    if (this.#options.diagnostics?.pitchFrames) {
      this.#emit("pitchFrame", this.#frameAt(t, loopMs));
    }
  }

  #syncNotes(t: SourceTimeMs, iteration: number): void {
    // End anything whose window has passed.
    for (const live of [...this.#live.values()]) {
      if (t >= live.endsAt) this.#endNote(live, live.endsAt);
    }

    for (const past of this.#startedSlots.keys()) {
      if (past < iteration - 1) this.#startedSlots.delete(past);
    }

    // Start anything whose window has opened. The score is scanned one
    // iteration back too, so a Note that rings past the loop boundary is not
    // restarted by its own next instance.
    for (const start of [iteration - 1, iteration]) {
      if (start < 0) continue;
      let started = this.#startedSlots.get(start);
      for (const entry of SCORE) {
        const startTime = start * LOOP_MS + entry.beat * BEAT_MS;
        const endsAt = startTime + entry.beats * BEAT_MS;
        if (t < startTime || t >= endsAt) continue;
        if (started?.has(entry.beat)) continue;

        const live = this.#beginNote(entry, startTime, endsAt);
        this.#live.set(live.id, live);
        if (!started) {
          started = new Set();
          this.#startedSlots.set(start, started);
        }
        started.add(entry.beat);
        this.#emit("noteStarted", this.#snapshot(live));
      }
    }

    // Then improve whatever is still sounding.
    for (const live of this.#live.values()) this.#advance(live, t);
  }

  /* ---- one Note's life ---- */

  #beginNote(entry: ScoreEntry, startTime: SourceTimeMs, endsAt: SourceTimeMs): LiveNote {
    const primaryIndex = entry.primaryIndex ?? 0;
    // A chord starts life as its own bass note: nothing yet says it is a chord.
    const trueMidi = entry.bloom ? (entry.midi[0] ?? 60) : (entry.midi[primaryIndex] ?? 60);
    const midi = entry.misheardAs?.midi ?? trueMidi;
    const origin = detectedPitch(midi, "first", 0.55, 0, 1);

    const live: LiveNote = {
      entry,
      id: `mock-n${++this.#noteSeq}`,
      startTime,
      endsAt,
      endTime: null,
      lifecycle: "started",
      revisionNumber: 0,
      lastChangeType: null,
      lastChangeAt: startTime,
      midi,
      bendCents: 0,
      peakBendCents: 0,
      bloomed: false,
      corrected: false,
      resolved: false,
      pruned: false,
      confidence: 0.55,
      amplitude: { rms: 0.02, peak: 0.05 },
      origin,
      active: [],
      trail: [],
    };

    live.active.push(
      this.#hypothesis("pitch", origin.name, "leading", 0.55, startTime)
    );

    // Every Note gets at least one rival, because every real one has: the
    // octave below is what a periodicity detector entertains at the attack and
    // drops once a few periods confirm the fundamental. Without it, an
    // uncontested Note would have an empty `hypotheses.trail` and the
    // "ruled out" UI would have nothing to show on most of the phrase.
    const rivals: Alternative[] =
      entry.alternatives ?? [
        { kind: "pitch", label: noteNameOf(midi - 12), confidence: 0.22 },
      ];
    for (const alternative of rivals) {
      live.active.push(
        this.#hypothesis(
          alternative.kind,
          alternative.label,
          alternative.confidence >= 0.35 ? "contender" : "candidate",
          alternative.confidence,
          startTime
        )
      );
    }

    return live;
  }

  /**
   * The weakest rival still being entertained, excluding the reading a pending
   * correction is about to supersede -- that one belongs to the correction, and
   * discrediting it first would leave `change.previous` pointing at a
   * hypothesis no longer in `active`.
   */
  #weakestRival(live: LiveNote): Hypothesis | undefined {
    const pendingCorrection =
      live.entry.misheardAs && !live.corrected
        ? noteNameOf(live.entry.misheardAs.midi)
        : null;
    return live.active
      .slice(1)
      .filter((h) => h.label !== pendingCorrection)
      .sort((a, b) => a.confidence - b.confidence)[0];
  }

  #advance(live: LiveNote, t: SourceTimeMs): void {
    const duration = live.endsAt - live.startTime;
    const progress = clamp01((t - live.startTime) / duration);
    const envelope = envelopeAt(progress);

    live.amplitude = { rms: 0.02 + envelope * 0.16, peak: 0.05 + envelope * 0.38 };
    live.confidence = clamp01(
      (live.entry.bloom ? 0.78 : 0.9) * (0.62 + 0.38 * progress) - Math.abs(jitter(t, 0.03))
    );

    const bendCents = this.#bendCentsAt(live.entry, progress);
    const wasBending = Math.abs(live.bendCents) >= 1;
    live.bendCents = bendCents;
    if (Math.abs(bendCents) > Math.abs(live.peakBendCents)) live.peakBendCents = bendCents;

    // Corrections first: everything after them describes the corrected Note.
    const misheard = live.entry.misheardAs;
    if (misheard && !live.corrected && progress >= misheard.at) {
      live.corrected = true;
      const trueMidi = live.entry.midi[live.entry.primaryIndex ?? 0] ?? live.midi;
      const wrongLabel = noteNameOf(misheard.midi);
      live.midi = trueMidi;
      const winner = this.#hypothesis("pitch", noteNameOf(trueMidi), "leading", 0.82, t);
      this.#supersede(live, wrongLabel, winner);
      live.active.unshift(winner);
      this.#change(live, t, "pitchCorrection", { label: wrongLabel, hypothesisId: winner.id });
      return;
    }

    const bloom = live.entry.bloom;
    if (bloom && !live.bloomed && progress >= bloom.at) {
      live.bloomed = true;
      const label = bloom.chordName ?? `${bloom.root} (unnamed)`;
      const winner = this.#hypothesis("harmony", label, "leading", 0.74, t);
      // The single-pitch reading is not wrong, it is subsumed: "E3" inside
      // "E:min". That is `incorporated`, not `discredited`.
      this.#incorporate(live, live.origin.name, winner);
      live.active.unshift(winner);
      this.#change(live, t, "harmonyEnrichment", { label: live.origin.name });
      return;
    }

    // Drop the weakest rival early, the way a few confirmed periods kill an
    // octave reading. This is what puts something in `hypotheses.trail` for the
    // bulk of a Note's life rather than only at the moment it settles.
    if (!live.pruned && progress >= 0.25) {
      live.pruned = true;
      const rival = this.#weakestRival(live);
      if (rival) {
        this.#discredit(live, rival, t);
        this.#change(live, t, "hypothesisDiscredited");
        return;
      }
    }

    if (Math.abs(bendCents) >= 1 && (!wasBending || t - live.lastChangeAt >= CHANGE_INTERVAL_MS)) {
      this.#change(live, t, "bendUpdate");
      return;
    }

    if (!live.resolved && progress >= RESOLVE_AT) {
      live.resolved = true;
      live.lifecycle = "resolved";
      live.revisionNumber += 1;
      live.lastChangeType = "resolved";
      live.lastChangeAt = t;
      // Settling promotes the leader and drops the weakest rival, so the trail
      // is never empty by the time a Note ends.
      const leader = live.active[0];
      if (leader) leader.state = "confirmed";
      const weakest = this.#weakestRival(live);
      if (weakest) this.#discredit(live, weakest, t);
      this.#emit("noteResolved", this.#snapshot(live));
      return;
    }

    if (t - live.lastChangeAt >= CHANGE_INTERVAL_MS) {
      this.#change(live, t, progress < 0.4 ? "pitchRefinement" : "confidenceUpdate");
    }
  }

  #change(
    live: LiveNote,
    t: SourceTimeMs,
    type: NoteChangeType,
    previous?: { label: string; hypothesisId?: string }
  ): void {
    if (live.lifecycle === "started") live.lifecycle = "enriching";
    live.revisionNumber += 1;
    live.lastChangeType = type;
    live.lastChangeAt = t;

    const change: NoteChange = { type, at: t, revisionNumber: live.revisionNumber };
    if (previous) change.previous = previous;
    this.#emit("noteChanged", this.#snapshot(live), change);
  }

  #endNote(live: LiveNote, endTime: SourceTimeMs): void {
    live.endTime = endTime;
    live.lifecycle = "ended";
    live.revisionNumber += 1;
    live.bendCents = this.#bendCentsAt(live.entry, 1);
    const ended = this.#snapshot(live);
    this.#live.delete(live.id);
    this.#remember(ended);
    this.#emit("noteEnded", ended);
  }

  /** `getNote()` answers for recently ended Notes too, so hold a few. */
  #remember(note: Note): void {
    this.#recent.set(note.id, note);
    while (this.#recent.size > 16) {
      const oldest = this.#recent.keys().next();
      if (oldest.done) break;
      this.#recent.delete(oldest.value);
    }
  }

  /* ---- hypotheses ---- */

  #hypothesis(
    kind: HypothesisKind,
    label: string,
    state: Hypothesis["state"],
    confidence: number,
    at: SourceTimeMs
  ): Hypothesis {
    return {
      id: `mock-h${++this.#hypothesisSeq}`,
      kind,
      label,
      state,
      confidence: clamp01(confidence),
      peakConfidence: clamp01(confidence),
      firstSeenAt: at,
      lastUpdatedAt: at,
    };
  }

  /** Replaced by a better explanation of the same evidence. */
  #supersede(live: LiveNote, label: string, winner: Hypothesis): void {
    const index = live.active.findIndex((h) => h.label === label);
    if (index < 0) return;
    const [loser] = live.active.splice(index, 1);
    if (!loser) return;
    loser.state = "superseded";
    loser.resolvedInto = winner.id;
    live.trail.push(loser);
  }

  /** Folded into a larger explanation -- "E3" inside "E:min". */
  #incorporate(live: LiveNote, label: string, winner: Hypothesis): void {
    const index = live.active.findIndex((h) => h.label === label);
    if (index < 0) return;
    const [absorbed] = live.active.splice(index, 1);
    if (!absorbed) return;
    absorbed.state = "incorporated";
    absorbed.resolvedInto = winner.id;
    live.trail.push(absorbed);
  }

  /** Actively contradicted by later evidence. */
  #discredit(live: LiveNote, hypothesis: Hypothesis, at: SourceTimeMs): void {
    const index = live.active.indexOf(hypothesis);
    if (index < 0) return;
    live.active.splice(index, 1);
    hypothesis.state = "discredited";
    hypothesis.lastUpdatedAt = at;
    live.trail.push(hypothesis);
  }

  /* ---- snapshots ---- */

  #snapshot(live: LiveNote): Note {
    const entry = live.entry;
    const bendActive =
      Math.abs(live.bendCents) >= (this.#options.engine?.bendThresholdCents ?? 25);

    const note: Note = {
      id: live.id,
      startTime: live.startTime,
      endTime: live.endTime,
      lifecycle: live.lifecycle,
      origin: {
        firstDetectedPitch: { ...live.origin },
        initialConfidence: 0.55,
        trigger: "attack",
      },
      pitch: {
        currentFrequencyHz: midiToHz(live.midi + live.bendCents / 100),
        current: detectedPitch(
          live.midi,
          live.bloomed ? "root" : "first",
          live.confidence,
          live.bendCents,
          1
        ),
        confidence: clamp01(live.confidence + 0.04),
      },
      hypotheses: {
        active: live.active.map((h) => ({ ...h })),
        trail: live.trail.map((h) => ({ ...h })),
      },
      revision: {
        lastChangeType: live.lastChangeType,
        revisionNumber: live.revisionNumber,
      },
      confidence: live.confidence,
      amplitude: { ...live.amplitude },
    };

    if (bendActive || live.peakBendCents !== 0) {
      note.bend = {
        active: bendActive,
        direction: live.peakBendCents >= 0 ? "up" : "down",
        amountCents: live.bendCents,
        peakAmountCents: live.peakBendCents,
        releaseDetected: live.lifecycle === "ended" && Math.abs(live.bendCents) < 20,
        confidence: clamp01(live.confidence - 0.1),
      };
    }

    // `harmony` is absent until the Note blooms. That absence IS the model: a
    // consumer cannot tell a chord from a note before the evidence arrives, and
    // neither can the recognizer.
    if (live.bloomed && entry.bloom) {
      const voicing = entry.midi.map((midi, index) =>
        detectedPitch(
          midi,
          index === 0 ? "bass" : "chordTone",
          clamp01(live.confidence - index * 0.06),
          jitter(live.lastChangeAt + index * 97, 2.5),
          1 - index * 0.18
        )
      );
      const harmony: NonNullable<Note["harmony"]> = {
        root: entry.bloom.root,
        confidence: clamp01(live.confidence - 0.05),
        detectedPitches: voicing,
        uniquePitchClassCount: new Set(voicing.map((pitch) => pitch.pitchClass)).size,
        estimatedVoiceCount: { value: entry.midi.length, confidence: 0.66 },
      };
      const bass = voicing[0];
      if (bass) harmony.bass = bass;
      // Left undefined on purpose for the abstaining chord: the recognizer
      // knows it is a chord and will not guess which one.
      if (entry.bloom.quality !== undefined) harmony.quality = entry.bloom.quality;
      if (entry.bloom.chordName !== undefined) harmony.chordName = entry.bloom.chordName;
      if (entry.bloom.intervals !== undefined) harmony.intervals = [...entry.bloom.intervals];
      note.harmony = harmony;
    }

    return note;
  }

  #bendCentsAt(entry: ScoreEntry, progress: number): number {
    if (entry.bendCents === undefined) return 0;
    const from = entry.bendFrom ?? 0.5;
    if (progress <= from) return 0;
    const bendProgress = clamp01((progress - from) / (1 - from));
    // Ease-out: a real bend arrives fast then holds.
    const eased = 1 - Math.pow(1 - bendProgress, 2);
    return entry.bendCents * eased;
  }

  /* ---- the diagnostic stream ---- */

  /** The continuous stream, including silence between Notes. */
  #frameAt(t: SourceTimeMs, loopMs: number): PitchFrame {
    // Find the sounding score entry, honouring a short release tail.
    let sounding: { entry: ScoreEntry; progress: number } | null = null;
    for (const entry of SCORE) {
      const startMs = entry.beat * BEAT_MS;
      const endMs = startMs + entry.beats * BEAT_MS;
      if (loopMs >= startMs && loopMs < endMs) {
        sounding = { entry, progress: (loopMs - startMs) / (endMs - startMs) };
        break;
      }
    }

    if (!sounding) {
      // Gated silence: the library still emits a frame.
      return {
        timestamp: t,
        frequencyHz: null,
        confidence: 0.04 + Math.abs(jitter(t, 0.06)),
        nearest: null,
        amplitude: { rms: 0.0015 + Math.abs(jitter(t, 0.001)), peak: 0.006 },
        // Stands in for a healthy stereo capture, so the per-channel meters
        // show what a working 2-in interface looks like.
        channelRms: [0.001 + Math.abs(jitter(t, 0.0008)), 0.0012 + Math.abs(jitter(t + 7, 0.0008))],
        // A real selector latches a channel on the first real signal and keeps
        // it through silence, so the mock does not flip back to "summing" every
        // time a Note ends.
        selectedChannel: 0,
        detector: { tau: null, cmnd: null, zeroCrossingHz: null },
      };
    }

    const { entry, progress } = sounding;
    const envelope = envelopeAt(progress);
    const primaryIndex = entry.primaryIndex ?? 0;
    // The fast lane locks onto the lowest strong partial of a chord, which is
    // exactly why a chord looks like a single pitch until the deep lane lands.
    const baseMidi = entry.bloom ? (entry.midi[0] ?? 60) : (entry.midi[primaryIndex] ?? 60);
    const bendCents = this.#bendCentsAt(entry, progress);

    // Vibrato + a little intonation drift, so the needle and the timeline move.
    const vibratoCents = 4.5 * Math.sin((t / 1000) * 2 * Math.PI * 5.2) * (progress > 0.25 ? 1 : 0);
    const driftCents = jitter(t, entry.bloom ? 6 : 3.5);
    const frequencyHz = midiToHz(baseMidi + (bendCents + vibratoCents + driftCents) / 100);

    const confidence = clamp01(
      (entry.bloom ? 0.74 : 0.93) * (0.55 + 0.45 * envelope) - Math.abs(jitter(t, 0.05))
    );

    return {
      timestamp: t,
      frequencyHz,
      confidence,
      nearest: nearestNote(frequencyHz),
      amplitude: { rms: 0.02 + envelope * 0.16, peak: 0.05 + envelope * 0.38 },
      channelRms: [0.014 + envelope * 0.11, 0.011 + envelope * 0.09],
      selectedChannel: 0,
      detector: {
        tau: SAMPLE_RATE / frequencyHz,
        cmnd: clamp01(1 - confidence) * 0.35,
        zeroCrossingHz: frequencyHz * (1 + jitter(t + 13, 0.02)),
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic pseudo-noise in [-amount, +amount], driven by time. */
function jitter(seed: number, amount: number): number {
  const x = Math.sin(seed * 0.017 + 1.3) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amount;
}

/** A plucked-string amplitude envelope over normalised Note progress. */
function envelopeAt(progress: number): number {
  const attack = clamp01(progress / 0.06);
  const decay = Math.exp(-2.1 * progress);
  const release = clamp01((1 - progress) / 0.18);
  return clamp01(attack * decay * release + 0.05);
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

/** Mirrors `createRecognizer(options)` from the library. */
export function createMockRecognizer(options: MockRecognizerOptions = {}): Recognizer {
  return new MockRecognizer(options);
}
