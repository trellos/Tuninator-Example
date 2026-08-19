# Tuninator-Example

A Vite browser demo for the [`tuninator`](https://github.com/trellos/Tuninator) guitar-analysis
library: a scrolling note timeline, a 90 bpm metronome, and a live tuner readout driven by the
library's `Note` stream and its opt-in `pitchFrame` diagnostic.

![The demo running against the mock source](./screenshot.png)

Everything here goes through `tuninator`'s **public API only** — `createRecognizer()` and
`RecognizerError` plus the types exported from the package entry point. Nothing reaches into
`tuninator/src/**` internals.

> **Targets Tuninator 0.2.** The library was rewritten from a pitch detector into a streaming
> musical event recognizer: `MusicEvent` became `Note`, the four modes were deleted, and a Note now
> *blooms* into a chord when the evidence supports it rather than being born one. See
> [Migrating to 0.2](#migrating-to-02) for what changed here.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

The library is a sibling checkout, declared as `"tuninator": "file:../Tuninator"`, so the layout is:

```
parent/
├── Tuninator/          # the library
└── Tuninator-Example/  # this repo
```

**The library must be on a revision that has the 0.2 recognizer API.** At time of writing that is
its `claude/guitar-event-recognizer-refactor-t5g5yr` branch — the library's `main` is still 0.1, and
this demo does not compile against it:

```bash
git clone https://github.com/trellos/Tuninator ../Tuninator
cd ../Tuninator
git checkout claude/guitar-event-recognizer-refactor-t5g5yr
npm install && npm run build        # emits dist/tuninator-worklet.js
cd ../Tuninator-Example && npm install
```

| script | what it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR, including changes to the library's source |
| `npm run build` | `tsc --noEmit` then `vite build` |
| `npm run typecheck` | typecheck only |
| `npm run preview` | serve the production build |
| `npm run smoke` | headless Chromium smoke test against the mock + saves `screenshot.png` |
| `npm run smoke:live` | the above, plus the real library against a fake audio device |

## URL parameters

| parameter | effect |
| --- | --- |
| *(none)* | **auto** — use the real library, falling back to the mock if it cannot be constructed |
| `?mock=1` | force the synthetic source (no microphone, no permission prompt) |
| `?mock=0` | force the real library |
| `?workletUrl=/nope.js` | point the library at a missing worklet, to exercise `worklet-load-failed` |
| `?failWith=<RecognizerErrorCode>` | make the mock's `start()` reject with that code, to exercise the error UI |
| `?channels=auto\|sum\|<index>` | `input.channels` — which input channel(s) the library analyses. `auto` (the default) selects the loudest; `sum` is the only way to *see* a mic and a DI of one guitar comb-filter into an octave error |
| `?metronome=1` | start the metronome on load |
| `?autostart=1` | start listening on load |

Source is switchable from the toolbar at runtime. **There is no mode selector**: 0.2 deleted modes
outright, and the recognizer decides.

---

## The worklet asset

The library needs a `workletUrl` pointing at its built AudioWorklet bundle. This demo passes
`/assets/tuninator-worklet.js`.

**That file is a copy of the library's `dist/tuninator-worklet.js`.** It is not authored here and it
is not committed — `.gitignore` excludes it, and `public/assets/.gitkeep` keeps the directory. The
copy is automatic: `vite.config.ts` installs a small plugin that copies
`../Tuninator/dist/tuninator-worklet.js` into `public/assets/` on every build and dev-server start,
and re-copies it whenever the library is rebuilt while the dev server is running.

So the ordinary workflow is:

```bash
cd ../Tuninator && npm run build   # produces dist/tuninator-worklet.js
cd ../Tuninator-Example && npm run dev
```

If the library has not been built yet, the copy step **warns and continues** rather than failing the
build. The demo still runs against the mock; the live path then reports `worklet-load-failed` in the
UI, which is the correct and legible outcome rather than a crash.

## Building against the library's source

`vite.config.ts` aliases `tuninator` to `../Tuninator/src/index.ts`, and `tsconfig.json` mirrors that
with a `paths` entry.

This exists because the library's `dist/` is produced by a concurrent workstream and may not exist
when you clone. Resolving the package through its `exports` map (`./dist/index.js`) would fail; the
alias keeps the demo building today and gives live reload on library changes.

`src/index.ts` **is** the library's public entry point, so this is not a way around the public API —
it is the public API, in source form. The rule the demo holds itself to is that this alias is the
only path into the library and no import ever deepens into `tuninator/src/**`.

> One consequence worth knowing: `tsconfig.json` deliberately leaves `noUnusedLocals` and
> `noUnusedParameters` off. The `paths` entry puts the library's own source into this TypeScript
> program, and compiler options cannot be applied per file — so those two *style* flags would fail
> this repo's build on unused variables in library code it does not own. Every flag that is on is a
> type-safety flag.

---

## What the demo shows

### Timeline (`src/timeline.ts`)

A canvas, redrawn on `requestAnimationFrame`.

- **Window**: 16 beats of history. At 90 bpm that is `16 × 666.67ms = 10.667s` on screen.
- **Geometry**: `x(t) = width × (1 − (now − t) / windowMs)`. New material enters at the **right**
  edge and the field scrolls **left**.
- **Bar length is Note duration.** A Note that has not ended yet (`endTime === null`) is drawn out
  to the right edge and grows as it is held.
- **Notes can overlap**, so bars are keyed by `note.id` and several may share a column — a restrum
  over a still-ringing chord is two bars, not one replacing the other.
- **Beat gridlines come from the metronome's own clock**, so a note played on the click sits on a
  gridline. Bar lines (every 4 beats) are brighter and numbered.
- **Pitch is the vertical axis**, with hue per pitch class and lightness rising with octave, over a
  **fixed** range: low E open to the high e's 12th fret (E2–E5, three octaves plus the low string).
  It does not adapt to what's currently sounding — an earlier version eased toward the active pitch
  span every frame, which read as the whole picture scrolling vertically. A pitch outside the fixed
  range still draws, pinned to the top or bottom edge. Octave guides are labelled `C3`, `C4`, …
- **Bars are labelled** `harmony.chordName ?? pitch.current.name`, and **dimmed in proportion to
  `confidence`** rather than hidden. A chord the recognizer will not name renders as `…`.
- **Bends stay one Note.** The ribbon follows `pitch.contour` when the library supplies it
  (`diagnostics: { contour: true }`) and falls back to sampling `bend.amountCents` per change,
  curving away from a dashed line at the origin pitch.
- `devicePixelRatio` is honoured, so nothing is blurry on a HiDPI display.

### Metronome (`src/metronome.ts`)

A textbook Web Audio **lookahead scheduler**: a `setInterval` of 25 ms decides *what* to play and
queues clicks ~100 ms ahead with `oscillator.start(audioContext.currentTime + …)`. Precision comes
entirely from those sample-accurate start times. Beat 1 of 4 is accented.

Clicks are never scheduled from `requestAnimationFrame` — rAF follows display refresh, is throttled
in background tabs, and jitters by whole frames, all of which is plainly audible on a click track.
rAF is used only for drawing.

### Panels (`src/ui.ts`)

Start/stop, `state` + `status` + `error`, live frequency and confidence, nearest note with cents and
a needle, the timebase from `getTimebase()`, one card per active `Note`, and a scrolling log.

Each Note card shows its `lifecycle` (`started` → `enriching` → `resolved` → `ended`), its revision
number, its chord tones, and both halves of `hypotheses`: what is still being entertained (`also:`)
and **what was considered and ruled out** (`ruled out:`, struck through). The trail is the most
visible new capability in 0.2 — it is what to show a player who disagrees with the answer.

The log distinguishes the four deliveries rather than flattening them: a start, a *revision* (a
bloom or an outright correction, which carries `change.previous`), the moment the answer settled,
and the end.

### Error handling

Every `RecognizerErrorCode` — `mic-unavailable`, `mic-permission-denied`, `audio-context-failed`,
`worklet-unavailable`, `worklet-load-failed`, `engine-load-failed`, `already-disposed`, `unknown` —
has a titled, human-readable explanation in the error banner. Nothing is left to a bare console
throw: `start()` rejections, `error` events, `window.onerror` and unhandled rejections all funnel
into the same banner, and anything that is not already a `RecognizerError` is normalised into one.

Try `?failWith=mic-permission-denied` (mock) or `?workletUrl=/nope.js` (real library).

### Mock source (`src/mock-tuninator.ts`)

A synthetic `Recognizer` that plays a fixed 16-beat phrase at 90 bpm — a lick, a bent B4, and three
chords (Em, C, and one it declines to name) — emitting the same `noteStarted` → `noteChanged` →
`noteResolved` → `noteEnded` sequence as the real library, plus the opt-in `pitchFrame` diagnostic
including silence frames with `frequencyHz: null` between notes.

It is a real implementation, not a stub, and it deliberately covers the paths the demo would
otherwise never exercise: a Note that **blooms** into a chord part-way through, one the recognizer
gets **wrong first** and corrects with `change.previous`, a chord it identifies but **will not
name**, a **bend**, **overlapping** Notes, and non-empty `hypotheses.active`/`.trail` so the
alternatives UI always has data.

That makes it a deterministic UI test harness needing no microphone, no permission prompt and no
audio hardware. `npm run smoke` drives it.

---

## Notes on the public API

Places where `types.ts` does not quite cover what the demo needs. None are worked around by reaching
into internals; each is handled defensively in the demo instead.

1. **`PitchFrame.channelRms` and `.selectedChannel` are never populated.** The capture worklet
   measures both and puts them on every `CaptureChunk`, but the browser adapter forwards only
   `samples` and `startSample` to the engine, so nothing downstream ever sees them. Both fields are
   optional, so this is a gap rather than a contract violation — but it means the live path cannot
   show which input channel is being analysed, which is the one thing that distinguishes "the guitar
   is in input 2 and the browser only captured channel 1" from "the detector is broken". The demo's
   per-channel meters therefore say *"not reported by this source"* on the live path rather than
   drawing an empty meter, and `scripts/smoke.mjs` reports it as a `NOTE` instead of turning the
   assertion vacuous. Fixing it needs a change in the library, not here.

2. **`host: "worker"` throws.** `RecognizerOptions.host` accepts it and `createWorkerHost()` rejects
   it with `engine-load-failed` — deliberately, and the error says so. The demo uses the default
   inline host and carries banner copy for the code anyway.

3. **The library's default `workletUrl` does not survive bundling.** It resolves
   `new URL("./tuninator-worklet.js", import.meta.url)`, which is correct when consuming the
   unbundled `dist/index.js` but points at a non-existent sibling of the output chunk when the
   library is bundled from source — Vite warns about exactly this at build time. The demo always
   passes an explicit `workletUrl`, so it is unaffected.

4. **No exported frequency↔note helper.** The timeline carries its own small copy for turning a
   `DetectedPitch` into a vertical position. `PitchFrame.nearest` covers the tuner readout, so this
   only matters for rendering Notes.

### Fixed by 0.2

Five of this list's seven 0.1 entries are gone, which is most of why the migration was worth doing:

| was | now |
| --- | --- |
| no way to share an `AudioContext` | `RecognizerOptions.audioContext`, never closed by the library. The demo passes one context to both the metronome and the recognizer |
| `PitchFrame.timestamp` had no documented epoch | `SourceTimeMs`, epoch 0, plus `getTimebase()` — so the timeline is *anchored* to the audio clock instead of estimating the offset |
| `start()`'s rejection type unspecified | documented as `RecognizerError`, and nothing else |
| `TuninatorError` was a plain object | `RecognizerError extends Error`: throwable, `instanceof`-able, carries a stack |
| every field of `EventPitch` optional but `role`/`confidence` | `DetectedPitch` requires `midi`, `name`, `pitchClass` and `octave` |
| no `dispose()` | `dispose()` releases the microphone and worklet; the demo calls it on `pagehide` and when switching source |

---

## Migrating to 0.2

What changed in this repo, for anyone holding a 0.1 integration of their own. The library's own
`docs/MIGRATION.md` is the full old→new reference.

| 0.1 | 0.2 |
| --- | --- |
| `createTuninator()` / `Tuninator` | `createRecognizer()` / `Recognizer` |
| `MusicEvent` | `Note` |
| `musicEventStart` / `Update` / `End` | `noteStarted` / `noteChanged(note, change)` / `noteEnded` |
| — | `noteResolved` — fires once, when the answer settles |
| `event.kind === "chord"` | `note.harmony !== undefined` |
| `event.label.name` | `note.harmony?.chordName ?? note.pitch.current?.name` |
| `event.state` (`attack`…`ended`) | `note.lifecycle` + `change.type` |
| `event.ambiguity.alternatives` | `note.hypotheses.active` and `.trail` |
| `event.bend.isActive` | `note.bend?.active` — `note.bend` is **absent** when there is no bend |
| `event.updatedAt` | gone; use `note.revision.revisionNumber` |
| `setMode()` / `TuninatorMode` | deleted. There are no modes |
| `getActiveEvents()` (0 or 1) | `getActiveNotes()` — genuinely plural |
| `stop(): void` | `await stop()`, which flushes |
| `options.analysis` / `.tracking` | `options.engine` |
| `pitchFrame` always on | opt-in via `diagnostics.pitchFrames` |

Three of those bite quietly rather than loudly, and each is handled in a named place here:

1. **The timestamp epoch moved.** 0.1 stamped everything with `AudioContext.currentTime * 1000`, so
   a context alive for 90s gave a first event at ~90000. 0.2 uses `SourceTimeMs` — audio since the
   first processed sample — so the first Note starts near 0, **and it restarts at 0 on every
   `start()`**. `WallClock` in `src/main.ts` owns the conversion and is reset on every transition to
   `starting`; without that reset its running minimum would place the whole timeline in the past
   after the first stop.

2. **Notes overlap.** Anything keyed on "the current event" has to be keyed on `note.id`. The
   timeline and the active-Notes panel both are, and the mock plays a chord that rings through the
   note after it so the case is exercised rather than assumed.

3. **`harmony` present with `chordName` undefined is honest abstention** — the recognizer knows it
   is a chord and will not name it. That renders as `…`, never as a guess. `labelOf()` in
   `src/ui.ts` is the single place that decides.
