/**
 * Scrolling note timeline.
 *
 * Geometry, exactly as specified:
 *   x(t) = width * (1 - (now - t) / windowMs)
 * so t == now lands on the RIGHT edge and older material slides LEFT. A bar's
 * length is the Note's duration; a Note that has not ended yet is drawn out to
 * the right edge and grows as time passes. Notes can overlap in 0.2, so bars
 * are keyed by `note.id` and several may share a column.
 *
 * The visible window is 16 beats of history. At 90bpm that is
 *   16 * (60000 / 90) = 16 * 666.667ms = 10666.67ms
 * and the beat gridlines come from the metronome's own grid, so what you see
 * lines up with what you hear.
 *
 * Everything in here works in `performance.now()` milliseconds ("wall" time).
 * Library timestamps are `SourceTimeMs` -- audio since the first processed
 * sample, epoch 0 -- and are converted on the way in via `toWall`. They are NOT
 * `performance.now()` and they restart at 0 on every `start()`; `main.ts` owns
 * that conversion and its reset.
 */

import type { DetectedPitch, Note, NoteLifecycle, SourceTimeMs } from "tuninator";

import { readTheme, withAlpha, type CanvasTheme } from "./theme.js";

import type { BeatGrid } from "./metronome.js";

/** Beats of history on screen. */
export const WINDOW_BEATS = 16;

const BAR_HEIGHT = 11;
const CHORD_TONE_HEIGHT = 7;
/**
 * The vertical axis is fixed, not adaptive: low E open to the high e's 12th
 * fret -- three octaves plus the low string, guitar's practical range.
 *
 * It used to ease toward whatever pitch span was currently sounding, which
 * read as the whole picture drifting vertically underneath the bars. A pitch
 * outside this fixed span still draws -- `#yOf` clamps to the top/bottom edge
 * rather than dropping it.
 */
const LOW_MIDI = 40; // E2, open low E
const HIGH_MIDI = 76; // E5, high e's 12th fret
const TRACE_LIMIT = 512;
const PAD_TOP = 18;
const PAD_BOTTOM = 22;

type Trace = { t: number; pitch: number };

type TrackedNote = {
  id: string;
  /** A Note is a chord once its harmony has bloomed, and not before. */
  kind: "note" | "chord";
  lifecycle: NoteLifecycle;
  label: string;
  /** Wall-clock ms. */
  startMs: number;
  /** Wall-clock ms, or null while the Note is still sounding. */
  endMs: number | null;
  confidence: number;
  /** Fractional MIDI for every pitch in the Note, primary first. */
  pitches: number[];
  primary: number | null;
  bendCents: number;
  /** Primary-pitch history, so a bend draws as a curve rather than a step. */
  trace: Trace[];
  /** True once `Note.pitch.contour` supplied the trace, which beats sampling it. */
  traceFromContour: boolean;
  /**
   * Wall-clock ms at which `harmony` first appeared, or null if it never did.
   *
   * A bloom is retroactive — once a Note is a chord, its whole extent is drawn
   * as one — so without a mark here the most characteristic 0.2 behaviour is
   * invisible in the primary view. It happened at a point in time; say where.
   */
  bloomedAtMs: number | null;
};

export type TimelineOptions = {
  /** Converts a `SourceTimeMs` into `performance.now()` space. */
  toWall: (sourceMs: SourceTimeMs) => number;
};

/* -------------------------------------------------------------------------- */
/* Pitch extraction                                                            */
/* -------------------------------------------------------------------------- */

const PITCH_CLASS_SEMITONES: Record<string, number> = {
  C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5,
  "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11,
};

function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/** "A4", "F#3" -> fractional MIDI. Returns null for chord labels like "Am7". */
function midiFromScientificName(name: string): number | null {
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!match) return null;
  const [, letter, accidental, octave] = match;
  if (letter === undefined || octave === undefined) return null;
  let semitone = PITCH_CLASS_SEMITONES[letter];
  if (semitone === undefined) return null;
  if (accidental === "#") semitone += 1;
  if (accidental === "b") semitone -= 1;
  return (Number(octave) + 1) * 12 + semitone;
}

/**
 * `DetectedPitch` guarantees `midi`, but its `frequencyHz` and `centsOffset` are
 * optional, so the fractional position is taken from whatever is present in
 * order of precision rather than assumed.
 */
function pitchOfDetected(pitch: DetectedPitch): number | null {
  if (typeof pitch.frequencyHz === "number" && pitch.frequencyHz > 0) {
    return hzToMidi(pitch.frequencyHz);
  }
  if (Number.isFinite(pitch.midi)) return pitch.midi + (pitch.centsOffset ?? 0) / 100;
  const fromName = midiFromScientificName(pitch.name);
  return fromName === null ? null : fromName + (pitch.centsOffset ?? 0) / 100;
}

/** The label a bar carries. Mirrors `labelOf()` in ui.ts. */
function labelOf(note: Note): string {
  if (note.harmony) return note.harmony.chordName ?? "…";
  return note.pitch.current?.name ?? "…";
}

function extractPitches(note: Note): { pitches: number[]; primary: number | null } {
  // The measurement first: `currentFrequencyHz` is continuous and survives a
  // bend, where `pitch.current` has already been snapped to a note.
  const primary =
    typeof note.pitch.currentFrequencyHz === "number" && note.pitch.currentFrequencyHz > 0
      ? hzToMidi(note.pitch.currentFrequencyHz)
      : note.pitch.current
        ? pitchOfDetected(note.pitch.current)
        : null;

  const others: number[] = [];
  for (const pitch of note.harmony?.detectedPitches ?? []) {
    const value = pitchOfDetected(pitch);
    if (value !== null) others.push(value);
  }

  // Last resort: a single-note label like "A4" still tells us where to draw.
  const fromLabel = midiFromScientificName(labelOf(note));
  const originPitch = note.origin.firstDetectedPitch
    ? pitchOfDetected(note.origin.firstDetectedPitch)
    : null;

  const resolvedPrimary = primary ?? others[0] ?? fromLabel ?? originPitch;
  const pitches =
    others.length > 0 ? others : resolvedPrimary !== null && resolvedPrimary !== undefined ? [resolvedPrimary] : [];

  return { pitches, primary: resolvedPrimary ?? null };
}

/** The vertical span of a pitch list, or null when there is nothing to span. */
function pitchExtent(pitches: readonly number[]): { lo: number; hi: number } | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const pitch of pitches) {
    if (pitch < lo) lo = pitch;
    if (pitch > hi) hi = pitch;
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? { lo, hi } : null;
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hue by pitch class, so the same note is always the same colour.
 *
 * The ramp is deliberately an ARC, not the full colour wheel: sweeping all
 * 360 degrees emits greens and oranges that sit outside the cyberpunk palette.
 * Spanning hueBase..hueBase+hueSpan (cyan -> violet -> magenta) keeps every
 * bar on-palette while preserving the encoding — twelve pitch classes still
 * map to twelve distinguishable hues.
 */
function hueOf(midi: number, theme: CanvasTheme): number {
  const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
  return (theme.hueBase + (pitchClass / 12) * theme.hueSpan) % 360;
}

function colourFor(midi: number, alpha: number, theme: CanvasTheme, lift = 0): string {
  const hue = hueOf(midi, theme);
  // Higher notes read brighter, which reinforces the vertical axis. The floor
  // is lifted from 44 to 52 because the ground is now pure black, where the
  // darkest bars previously disappeared.
  const light = Math.min(80, 52 + (midi - LOW_MIDI) * 0.42 + lift);
  return `hsla(${hue}, ${theme.sat}%, ${light}%, ${alpha})`;
}

/* -------------------------------------------------------------------------- */
/* Timeline                                                                    */
/* -------------------------------------------------------------------------- */

export class Timeline {
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #toWall: (sourceMs: SourceTimeMs) => number;

  #notes = new Map<string, TrackedNote>();
  #grid: BeatGrid = { originMs: performance.now(), periodMs: 60_000 / 90, beatsPerBar: 4 };

  #cssWidth = 0;
  #cssHeight = 0;
  #dpr = 1;

  #rafId: number | null = null;
  #observer: ResizeObserver | null = null;
  #hint = "Press Start to listen.";
  /** Cached: getComputedStyle inside the draw loop would thrash layout. */
  #theme: CanvasTheme = readTheme();

  constructor(canvas: HTMLCanvasElement, options: TimelineOptions) {
    this.#canvas = canvas;
    this.#toWall = options.toWall;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Timeline: 2D canvas context is unavailable.");
    this.#ctx = ctx;

    this.#theme = readTheme();
    this.#resize();
    if (typeof ResizeObserver !== "undefined") {
      this.#observer = new ResizeObserver(() => this.#resize());
      this.#observer.observe(canvas);
    } else {
      window.addEventListener("resize", () => this.#resize());
    }
  }

  get windowMs(): number {
    return WINDOW_BEATS * this.#grid.periodMs;
  }

  setGrid(grid: BeatGrid): void {
    this.#grid = grid;
  }

  setHint(hint: string): void {
    this.#hint = hint;
  }

  /**
   * Feed every `noteStarted` / `noteChanged` / `noteResolved` / `noteEnded`
   * through here, keyed by `note.id`.
   *
   * `atSourceMs` is when this delivery's evidence is from -- `change.at` for a
   * `noteChanged`, the Note's own start or end otherwise. There is no
   * `updatedAt` in 0.2, and using the delivery moment instead would smear a
   * bend's trace: the deep lane reports on audio the fast lane already passed.
   */
  track(note: Note, atSourceMs: SourceTimeMs): void {
    const startMs = this.#toWall(note.startTime);
    const endMs = note.endTime === null ? null : this.#toWall(note.endTime);
    const atMs = this.#toWall(atSourceMs);
    const { pitches, primary } = extractPitches(note);

    const existing = this.#notes.get(note.id);
    let trace = existing?.trace ?? [];
    let traceFromContour = existing?.traceFromContour ?? false;

    // `pitch.contour` (diagnostics: { contour: true }) is the library's own
    // frequency trajectory, at the fast lane's hop rate rather than at whatever
    // rate changes happen to be delivered. Prefer it, and stop sampling once it
    // arrives so the two cannot interleave.
    const contour = note.pitch.contour;
    if (contour && contour.length > 0) {
      trace = contour.map(([at, hz]) => ({ t: this.#toWall(at), pitch: hzToMidi(hz) }));
      if (trace.length > TRACE_LIMIT) trace.splice(0, trace.length - TRACE_LIMIT);
      traceFromContour = true;
    } else if (!traceFromContour && primary !== null) {
      const last = trace[trace.length - 1];
      if (!last || atMs - last.t > 25 || Math.abs(last.pitch - primary) > 0.01) {
        trace.push({ t: atMs, pitch: primary });
        if (trace.length > TRACE_LIMIT) trace.splice(0, trace.length - TRACE_LIMIT);
      }
    }

    // The first delivery carrying `harmony` for a Note already on screen is the
    // bloom. A Note whose very first delivery already has harmony did not
    // bloom — it arrived as one — and gets no mark.
    const bloomedAtMs =
      existing?.bloomedAtMs ??
      (note.harmony && existing && existing.kind === "note" ? atMs : null);

    this.#notes.set(note.id, {
      id: note.id,
      kind: note.harmony ? "chord" : "note",
      lifecycle: note.lifecycle,
      label: labelOf(note),
      startMs,
      endMs,
      confidence: note.confidence,
      pitches,
      primary,
      bendCents: note.bend?.amountCents ?? 0,
      trace,
      traceFromContour,
      bloomedAtMs,
    });
  }

  clear(): void {
    this.#notes.clear();
  }

  start(): void {
    if (this.#rafId !== null) return;
    const frame = (): void => {
      this.draw();
      this.#rafId = requestAnimationFrame(frame);
    };
    this.#rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    if (this.#rafId === null) return;
    cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
  }

  dispose(): void {
    this.stop();
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /* ---- rendering ---- */

  draw(): void {
    const now = performance.now();
    const width = this.#cssWidth;
    const height = this.#cssHeight;
    if (width <= 0 || height <= 0) return;

    this.#prune(now);

    const ctx = this.#ctx;
    ctx.fillStyle = this.#theme.ground;
    ctx.fillRect(0, 0, width, height);

    this.#drawPitchGuides(width, height);
    this.#drawBeatGrid(now, width, height);
    this.#drawNotes(now, width, height);
    this.#drawPlayhead(width, height);

    if (this.#notes.size === 0 && this.#hint) {
      ctx.fillStyle = this.#theme.hint;
      ctx.font = `14px ${this.#theme.fontMono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.#hint, width / 2, height / 2);
      ctx.textAlign = "left";
    }
  }

  /** x position for a wall-clock timestamp. */
  #xOf(t: number, now: number, width: number): number {
    return width * (1 - (now - t) / this.windowMs);
  }

  #yOf(midi: number, height: number): number {
    const usable = height - PAD_TOP - PAD_BOTTOM;
    const ratio = (midi - LOW_MIDI) / (HIGH_MIDI - LOW_MIDI);
    return PAD_TOP + usable * (1 - Math.min(1, Math.max(0, ratio)));
  }

  #prune(now: number): void {
    const cutoff = now - this.windowMs - 2000;
    for (const [id, note] of this.#notes) {
      const end = note.endMs ?? now;
      if (end < cutoff) this.#notes.delete(id);
    }
  }

  #drawPitchGuides(width: number, height: number): void {
    const ctx = this.#ctx;
    ctx.font = `10px ${this.#theme.fontMono}`;
    ctx.textBaseline = "middle";

    const first = Math.ceil(LOW_MIDI / 12) * 12;
    for (let midi = first; midi <= HIGH_MIDI; midi += 12) {
      const y = this.#yOf(midi, height);
      ctx.strokeStyle = this.#theme.guide;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.fillStyle = this.#theme.guideText;
      ctx.fillText(`C${Math.round(midi) / 12 - 1}`, 4, y - 7);
    }
  }

  /**
   * Beat lines straight off the metronome's grid, so a note played on the click
   * sits on a gridline.
   */
  #drawBeatGrid(now: number, width: number, height: number): void {
    const ctx = this.#ctx;
    const { originMs, periodMs, beatsPerBar } = this.#grid;
    const oldest = now - this.windowMs;
    const firstBeat = Math.ceil((oldest - originMs) / periodMs);
    const lastBeat = Math.floor((now - originMs) / periodMs);

    ctx.font = `10px ${this.#theme.fontMono}`;
    ctx.textBaseline = "top";

    for (let beat = firstBeat; beat <= lastBeat; beat += 1) {
      const t = originMs + beat * periodMs;
      const x = Math.round(this.#xOf(t, now, width)) + 0.5;
      if (x < 0 || x > width) continue;

      const isBarLine = ((beat % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
      ctx.strokeStyle = isBarLine ? this.#theme.barLine : this.#theme.guide;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, isBarLine ? 0 : PAD_TOP);
      ctx.lineTo(x, height - PAD_BOTTOM + 6);
      ctx.stroke();

      // Bar 1 is the metronome's origin. Beats before it exist (the window is
      // all history at page load) but numbering them 0 and -1 reads as a bug,
      // so those bar lines are drawn without a number.
      if (isBarLine) {
        const barNumber = Math.floor(beat / beatsPerBar) + 1;
        if (barNumber >= 1) {
          ctx.fillStyle = this.#theme.barLineText;
          ctx.fillText(String(barNumber), x + 3, height - PAD_BOTTOM + 8);
        }
      }
    }
  }

  #drawNotes(now: number, width: number, height: number): void {
    const ctx = this.#ctx;
    const ordered = [...this.#notes.values()].sort((a, b) => a.startMs - b.startMs);

    for (const note of ordered) {
      const endMs = note.endMs ?? now; // still sounding -> runs to the right edge
      const x0 = this.#xOf(note.startMs, now, width);
      const x1 = this.#xOf(endMs, now, width);
      if (x1 < -4 || x0 > width + 4) continue;

      // Dim low-confidence interpretations rather than hiding them.
      const alpha = 0.22 + 0.78 * clamp01(note.confidence);
      const left = Math.max(-2, x0);
      const right = Math.min(width, Math.max(x1, x0 + 2));
      const barWidth = Math.max(2, right - left);

      this.#drawChordGroup(note, left, right, height, alpha);

      // Chord tones behind, thinner and dimmer than the primary.
      for (const pitch of note.pitches) {
        if (note.primary !== null && Math.abs(pitch - note.primary) < 0.001) continue;
        const y = this.#yOf(pitch, height);
        ctx.fillStyle = colourFor(pitch, alpha * 0.5, this.#theme);
        cutRect(ctx, left, y - CHORD_TONE_HEIGHT / 2, barWidth, CHORD_TONE_HEIGHT, 2);
        ctx.fill();
      }

      if (note.primary === null) continue;

      const bent = Math.abs(note.bendCents) >= 20 && note.trace.length > 2;
      if (bent) {
        this.#drawBentBar(note, now, width, height, alpha);
      } else {
        const y = this.#yOf(note.primary, height);
        ctx.fillStyle = colourFor(note.primary, alpha, this.#theme, 6);
        cutRect(ctx, left, y - BAR_HEIGHT / 2, barWidth, BAR_HEIGHT, 3);
        ctx.fill();
      }

      // Attack marker: a bright cap at the note's onset.
      if (x0 >= -2 && x0 <= width) {
        const y = this.#yOf(note.trace[0]?.pitch ?? note.primary, height);
        ctx.fillStyle = withAlpha(this.#theme.highlight, 0.55 * alpha);
        ctx.fillRect(Math.max(0, x0), y - BAR_HEIGHT / 2, 2, BAR_HEIGHT);
      }

      this.#drawBloom(note, now, width, height, alpha);
      this.#drawLabel(note, left, right, height, alpha);
    }
  }

  /**
   * A background panel behind a chord's whole voicing.
   *
   * The chord-tone bars drawn just after this only share a time range —
   * nothing ties them to each other visually, so a four-note chord reads as
   * four coincidentally aligned bars rather than one thing. A panel spanning
   * the note's full pitch cluster, drawn first so every bar layers on top of
   * it, is what turns that into a single grouped object at a glance.
   *
   * A fill alone read as barely-there noise against pure black, so this
   * carries most of its contrast in the outline: a stroked edge is legible at
   * a much lower opacity than a flat tint needs to be, because it is a sharp
   * boundary rather than a gradual one. Luminance only (`theme.highlight`,
   * the same token the attack cap and bend origin use) for both — a new hue
   * here would compete with the pitch-class colour every bar already carries.
   */
  #drawChordGroup(
    note: TrackedNote,
    left: number,
    right: number,
    height: number,
    alpha: number
  ): void {
    if (note.kind !== "chord" || note.pitches.length < 2) return;
    const extent = pitchExtent(note.pitches);
    if (!extent) return;

    const top = this.#yOf(extent.hi, height) - BAR_HEIGHT / 2 - 3;
    const bottom = this.#yOf(extent.lo, height) + BAR_HEIGHT / 2 + 3;

    const ctx = this.#ctx;
    cutRect(ctx, left, top, right - left, bottom - top, 4);
    ctx.fillStyle = withAlpha(this.#theme.highlight, 0.2 * alpha);
    ctx.fill();
    ctx.strokeStyle = withAlpha(this.#theme.highlight, 0.5 * alpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /**
   * A tick where a Note became a chord.
   *
   * Blooming is retroactive in the drawing: once `harmony` arrives, the whole
   * bar is a chord, back to its own onset. That is right — it was always a
   * chord, the recognizer just did not know yet — but it erases the moment the
   * answer changed, which is the single most characteristic 0.2 behaviour.
   * This puts it back, as a dashed rule across the Note's own pitch span.
   */
  #drawBloom(
    note: TrackedNote,
    now: number,
    width: number,
    height: number,
    alpha: number
  ): void {
    if (note.bloomedAtMs === null || note.pitches.length === 0) return;
    const x = Math.round(this.#xOf(note.bloomedAtMs, now, width)) + 0.5;
    if (x < 0 || x > width) return;

    const extent = pitchExtent(note.pitches);
    if (!extent) return;

    const ctx = this.#ctx;
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = withAlpha(this.#theme.highlight, 0.65 * alpha);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, this.#yOf(extent.hi, height) - BAR_HEIGHT / 2 - 2);
    ctx.lineTo(x, this.#yOf(extent.lo, height) + BAR_HEIGHT / 2 + 2);
    ctx.stroke();
    ctx.restore();
  }

  /** A bend stays one note: draw the primary as a ribbon through its trace. */
  #drawBentBar(
    note: TrackedNote,
    now: number,
    width: number,
    height: number,
    alpha: number
  ): void {
    const ctx = this.#ctx;
    const points = note.trace.map((sample) => ({
      x: this.#xOf(sample.t, now, width),
      y: this.#yOf(sample.pitch, height),
    }));
    const last = points[points.length - 1];
    if (!last) return;
    // Extend the ribbon to the playhead while the note is still sounding.
    if (note.endMs === null) points.push({ x: width, y: last.y });

    const half = BAR_HEIGHT / 2;
    ctx.beginPath();
    const firstPoint = points[0];
    if (!firstPoint) return;
    ctx.moveTo(firstPoint.x, firstPoint.y - half);
    for (const point of points) ctx.lineTo(point.x, point.y - half);
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const point = points[i];
      if (point) ctx.lineTo(point.x, point.y + half);
    }
    ctx.closePath();
    ctx.fillStyle = colourFor(note.primary ?? 60, alpha, this.#theme, 6);
    ctx.fill();

    // A dashed ghost at the origin pitch makes the excursion legible.
    const originPitch = firstPoint ? note.trace[0]?.pitch : null;
    if (originPitch != null) {
      const y = this.#yOf(originPitch, height);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = withAlpha(this.#theme.highlight, 0.3 * alpha);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(firstPoint.x, y);
      ctx.lineTo(last.x, y);
      ctx.stroke();
      ctx.restore();
    }
  }

  #drawLabel(
    note: TrackedNote,
    left: number,
    right: number,
    height: number,
    alpha: number
  ): void {
    const ctx = this.#ctx;
    const available = right - left;
    if (available < 22 || note.primary === null) return;

    const text = note.label;
    ctx.font =
      note.kind === "chord"
        ? `500 11px ${this.#theme.fontMono}`
        : `11px ${this.#theme.fontMono}`;
    const metrics = ctx.measureText(text);
    if (metrics.width + 8 > available) return;

    const y = this.#yOf(note.primary, height);
    ctx.fillStyle = withAlpha(this.#theme.plate, 0.72 * alpha);
    ctx.fillRect(left + 3, y - BAR_HEIGHT / 2 - 14, metrics.width + 4, 13);
    ctx.fillStyle = withAlpha(this.#theme.plateText, Math.min(1, alpha + 0.15));
    ctx.textBaseline = "top";
    ctx.fillText(text, left + 5, y - BAR_HEIGHT / 2 - 13);
  }

  #drawPlayhead(width: number, height: number): void {
    const ctx = this.#ctx;
    const x = width - 0.5;
    ctx.strokeStyle = this.#theme.playhead;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();

    const gradient = ctx.createLinearGradient(width - 48, 0, width, 0);
    gradient.addColorStop(0, withAlpha(this.#theme.playhead, 0));
    gradient.addColorStop(1, withAlpha(this.#theme.playhead, 0.1));
    ctx.fillStyle = gradient;
    ctx.fillRect(width - 48, 0, 48, height);
  }

  /** Keep the backing store at device resolution so nothing is blurry. */
  #resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, Math.round(rect.width));
    const cssHeight = Math.max(1, Math.round(rect.height));

    if (cssWidth === this.#cssWidth && cssHeight === this.#cssHeight && dpr === this.#dpr) {
      return;
    }

    this.#cssWidth = cssWidth;
    this.#cssHeight = cssHeight;
    this.#dpr = dpr;
    this.#canvas.width = Math.round(cssWidth * dpr);
    this.#canvas.height = Math.round(cssHeight * dpr);
    this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 45-degree chamfered rectangle — the canvas counterpart of the CSS corner
 * cuts, so bars and panels share one geometry language.
 */
function cutRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  cut: number
): void {
  const c = Math.min(cut, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + width, y);
  ctx.lineTo(x + width, y + height - c);
  ctx.lineTo(x + width - c, y + height);
  ctx.lineTo(x, y + height);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
