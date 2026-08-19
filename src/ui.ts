/**
 * Everything that is not the canvas: transport controls, state/status/error
 * surfaces, the live tuner readout, the active-Note list and the note log.
 *
 * `ui.ts` knows about the DOM and about the library's public types; it knows
 * nothing about how a `Recognizer` is created or driven. `main.ts` owns that.
 */

import type {
  Hypothesis,
  Note,
  NoteChange,
  PitchFrame,
  RecognizerErrorCode,
  RecognizerErrorLike,
  RecognizerState,
  SourceTimeMs,
  Timebase,
} from "tuninator";

import { clamp } from "./pitch.js";

import type { MetronomeStatus } from "./metronome.js";

export type SourceChoice = "auto" | "mock" | "live";

export type UiCallbacks = {
  onToggleListen: () => void;
  onSourceChange: (source: SourceChoice) => void;
  onToggleMetronome: () => void;
  onMuteChange: (muted: boolean) => void;
};

const LOG_LIMIT = 150;
/** Hypotheses shown per Note. The trail is curated but still unbounded-ish. */
const HYPOTHESIS_LIMIT = 4;

/**
 * Human-readable copy for every code in `RecognizerErrorCode`. A raw code is
 * never shown on its own, and nothing is ever left to an uncaught console throw.
 */
const ERROR_COPY: Record<RecognizerErrorCode, { title: string; hint: string }> = {
  "mic-unavailable": {
    title: "No microphone found",
    hint: "Plug in or enable an input device, then press Start again.",
  },
  "mic-permission-denied": {
    title: "Microphone access was denied",
    hint:
      "The browser blocked microphone access. Allow it for this site " +
      "(the padlock icon in the address bar), then press Start again. " +
      "You can explore the demo without a microphone using the mock source.",
  },
  "audio-context-failed": {
    title: "Audio could not be started",
    hint: "The browser refused to create an AudioContext. Reload the page and press Start.",
  },
  "worklet-unavailable": {
    title: "AudioWorklet is not supported",
    hint: "This browser cannot run the capture worklet. Try a current Chrome, Edge, Firefox or Safari.",
  },
  "worklet-load-failed": {
    title: "The capture worklet could not be loaded",
    hint:
      "Check that `workletUrl` points at a real file. This demo expects " +
      "/assets/tuninator-worklet.js, copied from the library's dist/ by vite.config.ts.",
  },
  "engine-load-failed": {
    title: "The recognition engine could not be loaded",
    hint:
      "The engine host refused to start. `host: \"worker\"` is not available in " +
      "this build of the library; the demo uses the default inline host.",
  },
  "already-disposed": {
    title: "This recognizer was already disposed",
    hint: "A disposed recognizer cannot be restarted. Reload the page.",
  },
  unknown: {
    title: "Something went wrong",
    hint: "See the message below. Reload the page and try again.",
  },
};

const STATE_COPY: Record<RecognizerState, string> = {
  idle: "idle",
  starting: "starting…",
  listening: "listening",
  stopping: "stopping…",
  error: "error",
};

/**
 * What each `NoteChange` means in one word, for the log.
 *
 * The type is the point of `noteChanged` in 0.2: "I know more now" and "I was
 * wrong" arrive on the same subscription and must not read the same.
 */
const CHANGE_COPY: Record<NoteChange["type"], string> = {
  confidenceUpdate: "confidence",
  pitchRefinement: "refined",
  pitchCorrection: "corrected",
  pitchMovement: "moving",
  bendUpdate: "bend",
  pitchAdded: "pitch added",
  pitchRemoved: "pitch removed",
  harmonyEnrichment: "harmony",
  harmonyCorrection: "harmony corrected",
  hypothesisPromoted: "promoted",
  hypothesisDiscredited: "discredited",
  hypothesisIncorporated: "incorporated",
  structuralRevision: "restructured",
  resolved: "resolved",
};

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`ui: missing #${id} in index.html`);
  return element as T;
}

function formatHz(hz: number): string {
  return hz >= 1000 ? hz.toFixed(0) : hz.toFixed(1);
}

/**
 * What to call a Note.
 *
 * `harmony` present with `chordName` undefined is honest abstention: the
 * recognizer knows more than one pitch is sounding and will not guess which
 * chord. That renders as "…", never as a name picked here.
 */
export function labelOf(note: Note): string {
  if (note.harmony) return note.harmony.chordName ?? "…";
  return note.pitch.current?.name ?? "…";
}

function describeHypothesis(hypothesis: Hypothesis): string {
  return `${hypothesis.label} ${hypothesis.state} (${hypothesis.confidence.toFixed(2)})`;
}

export class Ui {
  readonly canvas: HTMLCanvasElement;

  #listenBtn: HTMLButtonElement;
  #sourceSelect: HTMLSelectElement;
  #metronomeBtn: HTMLButtonElement;
  #muteCheckbox: HTMLInputElement;

  #sourceBadge: HTMLElement;
  #statePill: HTMLElement;
  #statusMessage: HTMLElement;
  #errorBanner: HTMLElement;
  #errorTitle: HTMLElement;
  #errorCode: HTMLElement;
  #errorMessage: HTMLElement;
  #errorHint: HTMLElement;

  #noteName: HTMLElement;
  #noteDetail: HTMLElement;
  #centsValue: HTMLElement;
  #needle: HTMLElement;
  #frequency: HTMLElement;
  #confidenceFill: HTMLElement;
  #confidenceValue: HTMLElement;
  #levelFill: HTMLElement;
  #channelMeters: HTMLElement;
  #channelNote: HTMLElement;
  /** Bars currently in the DOM, rebuilt only when the channel count changes. */
  #channelBars: HTMLElement[] = [];
  #timebaseValue: HTMLElement;

  /** Ids kept from the 0.1 markup: `must()` and the smoke suite both key on them. */
  #activeNotes: HTMLElement;
  #noteLog: HTMLElement;

  #pendingFrame: PitchFrame | null = null;
  #pendingNotes: { notes: Note[]; sourceNowMs: SourceTimeMs } | null = null;
  #flushScheduled = false;

  constructor(callbacks: UiCallbacks) {
    this.canvas = must<HTMLCanvasElement>("timeline-canvas");

    this.#listenBtn = must<HTMLButtonElement>("listen-btn");
    this.#sourceSelect = must<HTMLSelectElement>("source-select");
    this.#metronomeBtn = must<HTMLButtonElement>("metronome-btn");
    this.#muteCheckbox = must<HTMLInputElement>("metronome-mute");

    this.#sourceBadge = must("source-badge");
    this.#statePill = must("state-pill");
    this.#statusMessage = must("status-message");
    this.#errorBanner = must("error-banner");
    this.#errorTitle = must("error-title");
    this.#errorCode = must("error-code");
    this.#errorMessage = must("error-message");
    this.#errorHint = must("error-hint");

    this.#noteName = must("note-name");
    this.#noteDetail = must("note-detail");
    this.#centsValue = must("cents-value");
    this.#needle = must("needle");
    this.#frequency = must("frequency-value");
    this.#confidenceFill = must("confidence-fill");
    this.#confidenceValue = must("confidence-value");
    this.#levelFill = must("level-fill");
    this.#channelMeters = must("channel-meters");
    this.#channelNote = must("channel-note");
    this.#timebaseValue = must("timebase-value");

    this.#activeNotes = must("active-events");
    this.#noteLog = must("event-log");

    this.#listenBtn.addEventListener("click", () => callbacks.onToggleListen());
    this.#metronomeBtn.addEventListener("click", () => callbacks.onToggleMetronome());
    this.#muteCheckbox.addEventListener("change", () =>
      callbacks.onMuteChange(this.#muteCheckbox.checked)
    );
    this.#sourceSelect.addEventListener("change", () =>
      callbacks.onSourceChange(this.#sourceSelect.value as SourceChoice)
    );
  }

  /* ---- transport / state ---- */

  setListening(listening: boolean, busy = false): void {
    this.#listenBtn.textContent = listening ? "Stop" : "Start listening";
    this.#listenBtn.classList.toggle("is-active", listening);
    this.#listenBtn.disabled = busy;
  }

  setState(state: RecognizerState): void {
    this.#statePill.textContent = STATE_COPY[state] ?? state;
    this.#statePill.dataset["state"] = state;
  }

  setStatus(message: string): void {
    this.#statusMessage.textContent = message;
  }

  setSource(choice: SourceChoice, effective: "mock" | "live"): void {
    this.#sourceSelect.value = choice;
    this.#sourceBadge.textContent = effective === "mock" ? "mock input" : "live microphone";
    this.#sourceBadge.dataset["kind"] = effective;
  }

  setMetronome(status: MetronomeStatus, bpm: number): void {
    this.#metronomeBtn.textContent = status.running
      ? `Metronome on · ${bpm} bpm`
      : `Metronome off · ${bpm} bpm`;
    this.#metronomeBtn.classList.toggle("is-active", status.running);
    if (status.message) this.setStatus(status.message);
  }

  /**
   * `getTimebase()`, rendered.
   *
   * Note timestamps are `SourceTimeMs` — audio since the first processed
   * sample, epoch 0 — and this is the only thing relating them to the host's
   * `AudioContext`. Showing it is how the demo makes the epoch change from 0.1
   * visible rather than merely correct.
   */
  setTimebase(timebase: Timebase | null): void {
    if (!timebase) {
      this.#timebaseValue.textContent = "—";
      return;
    }
    const origin =
      timebase.originContextTime === undefined
        ? "no ctx origin"
        : `ctx +${timebase.originContextTime.toFixed(3)}s`;
    this.#timebaseValue.textContent = `${timebase.sampleRate} Hz · ${origin}`;
  }

  /* ---- errors ---- */

  setError(error: RecognizerErrorLike | null): void {
    if (!error) {
      this.#errorBanner.hidden = true;
      return;
    }
    const copy = ERROR_COPY[error.code as RecognizerErrorCode] ?? ERROR_COPY.unknown;
    this.#errorTitle.textContent = copy.title;
    this.#errorCode.textContent = error.code;
    this.#errorMessage.textContent = error.message;
    this.#errorHint.textContent = copy.hint;
    this.#errorBanner.hidden = false;
  }

  /* ---- live readouts (batched to one paint per frame) ---- */

  setFrame(frame: PitchFrame): void {
    this.#pendingFrame = frame;
    this.#scheduleFlush();
  }

  setActiveNotes(notes: Note[], sourceNowMs: SourceTimeMs): void {
    this.#pendingNotes = { notes, sourceNowMs };
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    requestAnimationFrame(() => {
      this.#flushScheduled = false;
      if (this.#pendingFrame) {
        this.#renderFrame(this.#pendingFrame);
        this.#pendingFrame = null;
      }
      if (this.#pendingNotes) {
        this.#renderActiveNotes(this.#pendingNotes.notes, this.#pendingNotes.sourceNowMs);
        this.#pendingNotes = null;
      }
    });
  }

  #renderFrame(frame: PitchFrame): void {
    const { frequencyHz, nearest, confidence } = frame;

    if (frequencyHz === null || nearest === null) {
      this.#noteName.textContent = "—";
      this.#noteName.dataset["tuned"] = "off";
      this.#noteDetail.textContent = "no pitch";
      this.#centsValue.textContent = "";
      this.#needle.style.transform = "rotate(0deg)";
      this.#needle.dataset["tuned"] = "off";
      this.#frequency.textContent = "— Hz";
    } else {
      const cents = nearest.cents;
      this.#noteName.textContent = nearest.pitchClass;
      this.#noteDetail.textContent = `${nearest.name} · MIDI ${nearest.midi}`;
      this.#centsValue.textContent = `${cents >= 0 ? "+" : ""}${cents.toFixed(1)}¢`;
      // -50..+50 cents maps to -45..+45 degrees.
      this.#needle.style.transform = `rotate(${clamp(cents, -50, 50) * 0.9}deg)`;
      const inTune = Math.abs(cents) <= 5 ? "in" : Math.abs(cents) <= 15 ? "near" : "out";
      this.#needle.dataset["tuned"] = inTune;
      this.#noteName.dataset["tuned"] = inTune;
      this.#frequency.textContent = `${formatHz(frequencyHz)} Hz`;
    }

    const pct = clamp(confidence, 0, 1) * 100;
    this.#confidenceFill.style.width = `${pct.toFixed(1)}%`;
    this.#confidenceValue.textContent = confidence.toFixed(2);

    // rms is roughly 0..0.3 for guitar; a log scale keeps the meter readable.
    const rms = frame.amplitude.rms;
    const level = rms <= 0 ? 0 : clamp((20 * Math.log10(rms) + 60) / 60, 0, 1);
    this.#levelFill.style.width = `${(level * 100).toFixed(1)}%`;

    this.#renderChannels(frame.channelRms, frame.selectedChannel);
  }

  /**
   * Per-input-channel level, straight from `PitchFrame.channelRms`, plus which
   * channel the library is actually listening to.
   *
   * A 2-in interface is a single stereo device, an instrument in input 2 is on
   * channel 1 alone, and a browser that captured only channel 0 produces the
   * exact same screen as a broken detector. Showing the channels separately
   * turns that into something you can see in a second.
   *
   * `selectedChannel` is the other half of it and cannot be inferred from the
   * levels: selection is hysteretic, so the loudest channel in any one frame is
   * routinely not the one being analysed.
   *
   * Both fields are optional in `PitchFrame`, and the 0.2 browser adapter does
   * not populate either — the capture worklet measures them and the adapter
   * drops them on the way to the engine. The empty state below is therefore
   * what the live path currently shows, and it says so rather than rendering a
   * plausible-looking blank meter.
   */
  #renderChannels(channelRms: number[] | undefined, selected: number | null | undefined): void {
    if (!channelRms || channelRms.length === 0) {
      if (this.#channelBars.length > 0) {
        this.#channelMeters.replaceChildren();
        this.#channelBars = [];
      }
      this.#channelNote.textContent = "not reported by this source";
      delete this.#channelNote.dataset["warn"];
      return;
    }

    if (this.#channelBars.length !== channelRms.length) {
      this.#channelMeters.replaceChildren();
      this.#channelBars = channelRms.map((_, index) => {
        const row = document.createElement("div");
        row.className = "channel-row";

        const label = document.createElement("span");
        label.className = "channel-label";
        label.textContent = `ch${index}`;

        const meter = document.createElement("div");
        meter.className = "meter";
        const fill = document.createElement("div");
        fill.className = "meter-fill level";
        meter.append(fill);

        const db = document.createElement("span");
        db.className = "channel-db";
        db.textContent = "−∞ dB";

        row.append(label, meter, db);
        this.#channelMeters.append(row);
        return row;
      });
    }

    let live = 0;
    for (const [index, rms] of channelRms.entries()) {
      const row = this.#channelBars[index];
      if (!row) continue;
      const fill = row.querySelector<HTMLElement>(".meter-fill");
      const db = row.querySelector<HTMLElement>(".channel-db");
      const dbfs = rms <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
      // -60 dBFS is the floor the summed level meter above uses too.
      const silent = !(dbfs > -60);
      if (!silent) live += 1;
      if (fill) fill.style.width = `${(clamp((dbfs + 60) / 60, 0, 1) * 100).toFixed(1)}%`;
      if (db) db.textContent = silent ? "−∞ dB" : `${dbfs.toFixed(1)} dB`;
      row.dataset["silent"] = silent ? "yes" : "no";
      row.dataset["selected"] = selected === index ? "yes" : "no";
    }

    // Which channel is being analysed. Multi-channel only: on a mono capture
    // "listening to ch0" is noise, there was never a choice.
    const listening =
      channelRms.length <= 1
        ? ""
        : typeof selected === "number"
          ? ` · listening to ch${selected}`
          : selected === null
            ? " · summing all channels"
            : "";

    const count = `${channelRms.length} ch`;
    if (channelRms.length > 1 && live === 0) {
      this.#channelNote.textContent = `${count} · nothing on any channel${listening}`;
      this.#channelNote.dataset["warn"] = "yes";
    } else if (channelRms.length > 1 && live < channelRms.length) {
      this.#channelNote.textContent =
        `${count} · signal on ${live} of ${channelRms.length}${listening}`;
      this.#channelNote.dataset["warn"] = "yes";
    } else if (channelRms.length === 1) {
      // Named rather than warned about: a built-in laptop microphone really is
      // mono, so an amber banner here would cry wolf for most people. On a 2-in
      // interface the same words mean the browser captured one channel and
      // input 2 never reached the page at all -- which is exactly the question
      // this row exists to answer.
      this.#channelNote.textContent = "1 ch · mono capture";
      delete this.#channelNote.dataset["warn"];
    } else {
      this.#channelNote.textContent = `${count}${listening}`;
      delete this.#channelNote.dataset["warn"];
    }
  }

  /**
   * One card per active Note.
   *
   * Keyed by `note.id` rather than by "the current note": `getActiveNotes()` is
   * genuinely plural in 0.2, so a restrum over a still-ringing chord is two
   * cards at once.
   */
  #renderActiveNotes(notes: Note[], sourceNowMs: SourceTimeMs): void {
    if (notes.length === 0) {
      this.#activeNotes.innerHTML = '<p class="empty">nothing sounding</p>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const note of notes) {
      fragment.append(this.#noteCard(note, sourceNowMs));
    }
    this.#activeNotes.replaceChildren(fragment);
  }

  #noteCard(note: Note, sourceNowMs: SourceTimeMs): HTMLElement {
    const row = document.createElement("div");
    row.className = "event-card";
    // A Note is only a chord once its harmony has bloomed; before that it is
    // the same Note, drawn the same way. That IS the 0.2 model.
    row.dataset["kind"] = note.harmony ? "chord" : "note";

    const heading = document.createElement("div");
    heading.className = "event-card-head";

    const name = document.createElement("span");
    name.className = "event-name";
    name.textContent = labelOf(note);
    heading.append(name);

    const lifecycle = document.createElement("span");
    lifecycle.className = "chip";
    lifecycle.dataset["state"] = note.lifecycle;
    lifecycle.textContent = note.lifecycle;
    heading.append(lifecycle);

    if (note.revision.lastChangeType) {
      const change = document.createElement("span");
      change.className = "chip subtle";
      change.textContent = CHANGE_COPY[note.revision.lastChangeType];
      heading.append(change);
    }

    row.append(heading);

    const meta = document.createElement("dl");
    meta.className = "event-meta";
    const end = note.endTime ?? sourceNowMs;
    addMeta(meta, "conf", note.confidence.toFixed(2));
    addMeta(meta, "held", `${Math.max(0, Math.round(end - note.startTime))} ms`);
    // `updatedAt` is gone in 0.2; the revision number is what makes a held
    // snapshot's staleness checkable.
    addMeta(meta, "rev", String(note.revision.revisionNumber));
    if (note.pitch.currentFrequencyHz !== undefined) {
      addMeta(meta, "f0", `${formatHz(note.pitch.currentFrequencyHz)} Hz`);
    }
    addMeta(meta, "from", note.origin.trigger);
    if (note.harmony?.quality) addMeta(meta, "quality", note.harmony.quality);
    if (note.harmony && !note.harmony.chordName) {
      // Honest abstention, spelled out. The recognizer knows it is a chord and
      // will not name it; a guess here would be the demo inventing data.
      addMeta(meta, "chord", "unnamed (abstained)");
    }
    if (note.bend) {
      const cents = note.bend.amountCents;
      const peak = note.bend.peakAmountCents;
      const released = note.bend.releaseDetected ? " · released" : "";
      addMeta(
        meta,
        "bend",
        `${note.bend.direction} ${cents >= 0 ? "+" : ""}${cents.toFixed(0)}¢ ` +
          `(peak ${peak.toFixed(0)}¢)${released}`
      );
    }
    const voices = note.harmony?.estimatedVoiceCount;
    if (voices) addMeta(meta, "voices", `${voices.value} (${voices.confidence.toFixed(2)})`);
    row.append(meta);

    const tones = note.harmony?.detectedPitches ?? [];
    if (tones.length > 1) {
      const line = document.createElement("div");
      line.className = "event-tones";
      line.textContent = tones.map((pitch) => pitch.name).join(" · ");
      row.append(line);
    }

    // What is still being entertained, and what was considered and dropped.
    // The trail is the most visible new capability in 0.2: it is what to show a
    // player who disagrees with the answer.
    const active = note.hypotheses.active.filter((h) => h.label !== labelOf(note));
    if (active.length > 0) {
      const alt = document.createElement("div");
      alt.className = "event-alt";
      alt.textContent = `also: ${active.slice(0, HYPOTHESIS_LIMIT).map(describeHypothesis).join(", ")}`;
      row.append(alt);
    }

    if (note.hypotheses.trail.length > 0) {
      const trail = document.createElement("div");
      trail.className = "event-alt trail";
      trail.textContent = `ruled out: ${note.hypotheses.trail
        .slice(-HYPOTHESIS_LIMIT)
        .map(describeHypothesis)
        .join(", ")}`;
      row.append(trail);
    }

    return row;
  }

  /* ---- log ---- */

  logStarted(note: Note): void {
    this.#appendLog("start", "▶", labelOf(note), `conf ${note.confidence.toFixed(2)}`);
  }

  /**
   * A Note that started as a single pitch and grew a chord identity.
   *
   * Logged separately from every other change because it is the behaviour the
   * whole 0.2 model exists for, and because it reads as a *correction* in any UI
   * that only shows the final name.
   */
  logBloom(note: Note, change: NoteChange): void {
    const was = change.previous?.label ?? note.origin.firstDetectedPitch?.name ?? "a single pitch";
    this.#appendLog("change", "✽", labelOf(note), `bloomed from ${was} · rev ${change.revisionNumber}`);
  }

  logChange(note: Note, change: NoteChange): void {
    const previous = change.previous ? ` (was ${change.previous.label})` : "";
    const related = change.relatedNoteIds?.length
      ? ` · with ${change.relatedNoteIds.join(", ")}`
      : "";
    this.#appendLog(
      "change",
      "↻",
      labelOf(note),
      `${CHANGE_COPY[change.type]}${previous}${related} · rev ${change.revisionNumber}`
    );
  }

  logResolved(note: Note): void {
    this.#appendLog("resolved", "✓", labelOf(note), `settled · conf ${note.confidence.toFixed(2)}`);
  }

  logEnded(note: Note): void {
    const held = note.endTime === null ? 0 : Math.round(note.endTime - note.startTime);
    const bend = note.bend
      ? ` · bend ${note.bend.peakAmountCents >= 0 ? "+" : ""}${note.bend.peakAmountCents.toFixed(0)}¢`
      : "";
    this.#appendLog("end", "■", labelOf(note), `${held} ms${bend}`);
  }

  logNote(message: string): void {
    const line = document.createElement("div");
    line.className = "log-line";
    line.dataset["phase"] = "note";
    const detail = document.createElement("span");
    detail.className = "log-detail";
    detail.textContent = message;
    line.append(detail);
    this.#prependLine(line);
  }

  #appendLog(
    phase: "start" | "change" | "resolved" | "end",
    marker: string,
    label: string,
    detail: string
  ): void {
    const line = document.createElement("div");
    line.className = "log-line";
    line.dataset["phase"] = phase;

    const markerEl = document.createElement("span");
    markerEl.className = "log-marker";
    markerEl.textContent = marker;

    const labelEl = document.createElement("span");
    labelEl.className = "log-label";
    labelEl.textContent = label;

    const detailEl = document.createElement("span");
    detailEl.className = "log-detail";
    detailEl.textContent = detail;

    line.append(markerEl, labelEl, detailEl);
    this.#prependLine(line);
  }

  #prependLine(line: HTMLElement): void {
    this.#noteLog.prepend(line);
    while (this.#noteLog.childElementCount > LOG_LIMIT) {
      this.#noteLog.lastElementChild?.remove();
    }
  }

  clearLog(): void {
    this.#noteLog.replaceChildren();
  }
}

function addMeta(list: HTMLDListElement, term: string, value: string): void {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  list.append(dt, dd);
}
