# AGENTS.md

Orientation for coding agents working in this repo. `README.md` is the human quick-start; this file
is the stuff that is expensive to rediscover and easy to break.

---

## What this is

A browser demo for the [`tuninator`](https://github.com/trellos/Tuninator) guitar-analysis library,
targeting **0.2** — the streaming musical event recognizer, not the 0.1 pitch detector. It listens
to a guitar — real microphone or a deterministic synthetic mock — and visualises:

- **`Note`** — the primary stream. A Note starts as soon as there is evidence something was played
  and then *improves*: `noteStarted` → `noteChanged(note, change)` → `noteResolved` → `noteEnded`.
- **`pitchFrame`** — the continuous pitch/confidence/level stream underneath it. **Opt-in** in 0.2
  (`diagnostics: { pitchFrames: true }`); the demo asks for it, and for `contour` too.

Its job is to make the library's behaviour *visible*, including the failure modes. Several parts
exist specifically to expose problems rather than to look good — the per-channel meters, the
hypothesis trail, the error banner's per-code copy, the `?failWith=` and `?shim=` hooks. Treat that
as the design intent: when adding to this demo, prefer surfacing what the library is doing over
hiding it.

It is one screen, no routing, no framework. Deployed to GitHub Pages at
`https://trellos.github.io/Tuninator-Example/`.

---

## The one thing that will trip you up first

**The demo does not build without a sibling checkout of the library.**

`package.json` declares `"tuninator": "file:../Tuninator"` and `vite.config.ts` aliases the import to
`../Tuninator/src/index.ts`. The package is **not published to npm**. `src/main.ts` imports
`createRecognizer` and `RecognizerError` as *values*, so `?mock=1` does not rescue a missing library
— Vite fails to resolve the module before any query parameter is read.

```
parent/
├── Tuninator/          <- the library, MUST be named exactly this
└── Tuninator-Example/  <- this repo
```

```bash
git clone https://github.com/trellos/Tuninator ../Tuninator
cd ../Tuninator
# The 0.2 recognizer API is not on the library's main yet. This demo does not
# compile against main; see the deployment section on LIBRARY_REF.
git checkout claude/guitar-event-recognizer-refactor-t5g5yr
npm ci && npm run build                      # emits dist/tuninator-worklet.js
cd ../Tuninator-Example && npm ci
```

The directory name is load-bearing: `vite.config.ts` does `path.resolve(here, "..", "Tuninator")`.
CI does the same thing — see `.github/workflows/deploy-pages.yml`, which checks out the library at
`LIBRARY_REF` into a sibling path.

**When a typecheck fails right after pulling, suspect the library first.** The demo tracks the
library's `main`, and new demo features routinely land against library APIs that a stale local
checkout does not have. Update and rebuild `../Tuninator` before assuming your change is at fault.

---

## Architecture

Data flows one way: library → `App` → the view objects. Nothing calls back up.

```
Recognizer (real or MockRecognizer)
      │  note* / pitchFrame
      ▼
   App  (src/main.ts)  ── owns settings, wiring, error funnel, WallClock,
      │                    and the one shared AudioContext
      ├──▶ Ui        (src/ui.ts)        panels, tuner, Note cards, log
      ├──▶ Timeline  (src/timeline.ts)  the <canvas>
      └──▶ Metronome (src/metronome.ts) Web Audio clock → BeatGrid
```

| file | responsibility |
|---|---|
| `index.html` | **All** markup. Static skeleton; nothing generates it. |
| `src/main.ts` | `App`: reads URL settings, constructs the source, funnels every error to one place, owns the shared `AudioContext` and `WallClock` (`SourceTimeMs` → `performance.now()`). |
| `src/ui.ts` | `Ui`: imperative DOM controller. Owns `STATE_COPY` / `ERROR_COPY` / `CHANGE_COPY` and `labelOf()`. |
| `src/timeline.ts` | `Timeline`: the scrolling canvas. Its own rAF loop. |
| `src/theme.ts` | `readTheme()` — bridges CSS custom properties into the canvas. |
| `src/metronome.ts` | Lookahead Web Audio scheduler. No DOM. |
| `src/mock-tuninator.ts` | Deterministic synthetic `Recognizer`. No DOM. Filename kept; the export is `createMockRecognizer`. |
| `src/styles.css` | The only stylesheet. |
| `scripts/smoke.mjs` | Playwright suite. The real test coverage. |

### Conventions that are load-bearing

**State is expressed with `data-*` attributes, not class toggles.** TS sets
`el.dataset["state"] = "listening"`; CSS selects `.pill[data-state="listening"]`. Keep this — it is
why the whole UI could be re-themed without touching `ui.ts`.

**`Ui` renders in one paint per frame.** Mutations mark dirty flags and `#scheduleFlush()` coalesces
into a single `requestAnimationFrame`. Do not write to the DOM directly from an event handler.

**`must(id)` throws if an element is missing**, so `index.html` and `ui.ts` are tightly coupled by
design — a typo fails loudly at construction rather than silently rendering nothing.

**The mock is a real implementation, not a stub.** `?mock=1` runs the entire UI with no microphone,
no permission prompt and no library behaviour — which is what makes the smoke suite deterministic.
When adding a field to the library's `Note` or frame types, add it to `mock-tuninator.ts` too or the
default demo goes blank where the real one does not.

It also deliberately covers paths the real library only reaches sometimes: a Note that **blooms**
into a chord, one **corrected** with `change.previous`, a chord it **will not name**, a **bend**,
**overlapping** Notes, and non-empty `hypotheses.active`/`.trail`. Each of those has a smoke check.
Changing the score can break one — check `npm run smoke` before assuming a rewrite of `SCORE` is
cosmetic.

---

## UI choices

The demo is styled **retro-cyberpunk**, applied with the skill in
`.claude/skills/cyberpunk-ui/`. Read that skill before making visual changes — especially
`references/video-guideline.md`, which is the verbatim source spec the palette comes from.

**Palette values are not arbitrary.** They are the ones stated in the source guideline: background
`#000000`; primaries `#00FF00` / `#00FFFF` / `#FF00FF`; secondaries `#FFD700` / `#FF4500`. They map
onto the demo's semantic roles — cyan primary, magenta secondary/active, green/gold/orange-red for
in-tune / near / out.

**Change token values, not token names.** `:root` in `src/styles.css` is the single source of truth.
The entire GitHub-dark → cyberpunk restyle was done by revaluing that block; every component rule and
`[data-state]` selector kept working untouched. New colour belongs in a token, not inline.

**The canvas reads the CSS tokens** via `readTheme()` (`src/theme.ts`), which pulls the `--canvas-*`
custom properties off the document element. It is cached on the `Timeline` instance and re-read on
resize — never call `getComputedStyle` inside the draw loop. Always keep the fallbacks in
`theme.ts`: a missing custom property returns `""`, and `ctx.fillStyle = ""` silently keeps the
*previous* colour, producing a canvas that is subtly wrong rather than obviously broken.

**Pitch-class hue is an arc, not a wheel.** `colourFor()` maps twelve pitch classes across
`--canvas-hue-base` → `+--canvas-hue-span` (cyan → violet → magenta) so every bar stays on-palette
while the encoding survives. Collapsing it to a single hue destroys both the encoding and the smoke
check that counts distinct colours.

**Neon is the state layer, never the text layer.** Body copy is neutral (`--text`); glow
(`--glow-1` / `--glow-2`) goes only on things that are live or actionable. If more than roughly a
tenth of the frame glows, it has gone wrong.

**Geometry is angular.** `--radius: 0`, with 45° chamfers. Use `clip-path` only on non-focusable
decoration — it clips both `outline` and outer `box-shadow`. Interactive elements use the gradient
corner-cut, which keeps the border, focus ring and glow.

**Motion is gated.** `prefers-reduced-motion` stops decoration (scanline flicker, glitch) but must
not stop data — the timeline's rAF loop and the needle carry information and keep running.

---

## Testing and verification

`scripts/smoke.mjs` is the test suite. There are no unit tests.

```bash
npm run typecheck     # tsc --noEmit
npm run smoke         # mock path; builds, serves, drives Chromium, rewrites screenshot.png
npm run smoke:live    # the above PLUS the real library, stereo and comb-filter scenarios
```

It prints `PASS` / `FAIL` and also `NOTE` — an observation that is neither, used where the library
stopped supplying something optional. A `NOTE` never fails the run; see the library-gap section
below for why it is a note and not a check.

`npm run smoke:live` is the one that matters before pushing — it exercises the real library end to
end, including a synthetic two-channel stream. **Run it with no stray `vite preview` on port 4173**;
a leftover server silently serves a previous build and makes the run untrustworthy.

`screenshot.png` is generated by the smoke run and embedded in `README.md`. Regenerate it rather than
hand-editing, and expect it to conflict on every merge — resolve by regenerating from the merged
tree, never by picking a side.

### Two traps the suite has already caught

**`text-transform: uppercase` changes what `innerText` returns.** Playwright reads rendered text, so
uppercasing an element the suite asserts on breaks an exact-match check. `#state-pill`,
`#source-badge` and `#error-code` therefore use `font-variant-caps: all-small-caps`, which renders as
caps without touching the text node. `#error-title` is also read by the suite, and is left in
sentence case at a larger size instead — synthesised small-caps in a pixel display face turns to mush
under the scanline overlay, and that is the one string that has to stay readable. `textContent`
assertions are unaffected by either.

**A colour probe can pass while asserting nothing.** The canvas ink check counts pixels differing
from the ground. It once hardcoded `#0d1117`; against a black ground it still passed — reporting
~100% and testing nothing. It now reads `--canvas-ground` from computed style. If you add a
pixel-sampling assertion, derive the expected colour from a token.

Also: renaming an `id` in `index.html` breaks both `must()` and the suite's selectors. If you must
rename one, grep `scripts/smoke.mjs` first.

---

## URL parameters

Debug hooks, all listed in `README.md` and surfaced in the page footer. The ones worth knowing:

| parameter | effect |
|---|---|
| `?mock=1` / `?mock=0` | force the synthetic source / force the real library |
| `?channels=auto\|sum\|<index>` | the library's `input.channels` |
| `?failWith=<RecognizerErrorCode>` | make the mock's `start()` reject with that code |
| `?workletUrl=/nope.js` | exercise `worklet-load-failed` |
| `?shim=silent-ch0\|comb` | smoke-suite-only synthetic `getUserMedia` streams |

`?mode=` is gone with the modes themselves. The smoke suite asserts no mode selector exists, so
re-adding one fails the run rather than quietly drifting back.

---

## Deployment

`.github/workflows/deploy-pages.yml` builds and publishes to GitHub Pages on push to `main`, plus
`workflow_dispatch`. **There is no `pull_request` trigger** — a PR against this repo shows no checks,
which is expected, not a stuck build. Local `npm run smoke:live` is the evidence for a PR.

`LIBRARY_REF` pins which library revision CI builds against. It is currently a **commit SHA** on the
library's `claude/guitar-event-recognizer-refactor-t5g5yr` branch, because the 0.2 recognizer API
this demo targets is not on the library's `main` yet — the demo does not compile against `main`.

A SHA rather than the branch name on purpose: a feature branch works right up until it is deleted by
its own merge, and then fails opaquely. Tracking `main` is still the steady state — **move it back
the moment the library's rewrite lands there.**

### Known benign build output

Vite may log `new URL("./tuninator-worklet.js", import.meta.url) doesn't exist at build time`. This
is a plain log line, not a run annotation. It comes from the *library's* default `workletUrl`, and
the demo always passes an explicit one, so it is a branch this build never takes. Fixing it properly
requires a change in the library repo, not here.

---

## The 0.2 migration, and what it left behind

The demo was moved from the 0.1 pitch detector to the 0.2 recognizer. `README.md` has the full
old→new table; these are the parts that are easy to get wrong again.

**Source time restarts at 0 on every `start()`.** `SourceTimeMs` is audio since the first processed
sample, not `AudioContext.currentTime` and not `performance.now()`. `WallClock` in `src/main.ts`
converts, and it is reset on every transition to `starting`. Without that reset its running minimum
survives a stop, and the whole timeline is drawn in the past after the first restart. This fails
*silently* — the canvas is simply empty — so it will not announce itself.

**One `AudioContext`, owned by the page.** `createSharedContext()` makes it, the metronome borrows
it via `useContext()`, and it is passed to the library as `RecognizerOptions.audioContext`. The
library never closes a context it did not create, so nothing else may close it either; `App` closes
it on `pagehide` and nowhere else. This is also what lets `WallClock.anchor()` pin the timeline to
the audio clock instead of estimating — the fallback estimator still exists for the mock, which has
no context.

**`note.harmony` present with `chordName` undefined is honest abstention.** `labelOf()` in
`src/ui.ts` is the single place that turns a Note into a string, and it renders `…`. Do not add a
second one that guesses.

**Notes overlap.** Everything is keyed by `note.id`. The mock's C chord rings through the note after
it specifically so this is exercised rather than assumed.

### One library gap the demo now works around

`PitchFrame.channelRms` and `.selectedChannel` are **not populated on the live path**. The capture
worklet measures both and posts them on every `CaptureChunk`; `BrowserRecognizer` forwards only
`samples` and `startSample` to the engine, so they never reach a `PitchFrame`. Both fields are
optional, so this is a gap rather than a broken contract.

Consequences to keep in mind:

- The per-channel meters say *"not reported by this source"* on the live path. That copy is
  load-bearing — it is the difference between "the library did not tell us" and "there is no
  signal", and the smoke suite asserts it.
- `scripts/smoke.mjs` reports the gap with `note()`, not `check()`. **Do not turn those back into
  assertions against the current library** — they would fail. Equally, do not delete the surrounding
  checks: the comb-filter pair (`channels=sum` reads an octave high, `auto` reads E3) is now the
  *only* evidence that selection is happening at all, because `selectedChannel` no longer says so.
- The channel-meter rendering is asserted on the **mock** run instead, which still supplies the
  fields.

If a later library revision starts forwarding them, both `check()` branches are still in
`runStereoChannelCheck` behind an `if` and will start running on their own.
