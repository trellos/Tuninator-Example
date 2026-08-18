# AGENTS.md

Orientation for coding agents working in this repo. `README.md` is the human quick-start; this file
is the stuff that is expensive to rediscover and easy to break.

---

## What this is

A browser demo for the [`tuninator`](https://github.com/trellos/Tuninator) guitar-analysis library.
It listens to a guitar — real microphone or a deterministic synthetic mock — and visualises the
library's two output streams:

- **`pitchFrame`** — the continuous pitch/confidence/level stream, ~90 frames/sec
- **`MusicEvent`** — higher-level note and chord events with `start` / `update` / `end` phases

Its job is to make the library's behaviour *visible*, including the failure modes. Several parts
exist specifically to expose problems rather than to look good — the per-channel meters, the error
banner's per-code copy, the `?failWith=` and `?shim=` hooks. Treat that as the design intent: when
adding to this demo, prefer surfacing what the library is doing over hiding it.

It is one screen, no routing, no framework. Deployed to GitHub Pages at
`https://trellos.github.io/Tuninator-Example/`.

---

## The one thing that will trip you up first

**The demo does not build without a sibling checkout of the library.**

`package.json` declares `"tuninator": "file:../Tuninator"` and `vite.config.ts` aliases the import to
`../Tuninator/src/index.ts`. The package is **not published to npm**. `src/main.ts` imports
`createTuninator` as a *value*, so `?mock=1` does not rescue a missing library — Vite fails to
resolve the module before any query parameter is read.

```
parent/
├── Tuninator/          <- the library, MUST be named exactly this
└── Tuninator-Example/  <- this repo
```

```bash
git clone https://github.com/trellos/Tuninator ../Tuninator
cd ../Tuninator && npm ci && npm run build   # emits dist/tuninator-worklet.js
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
Tuninator (or MockTuninator)
      │  pitchFrame / musicEvent
      ▼
   App  (src/main.ts)  ── owns settings, wiring, error funnel, Timebase
      ├──▶ Ui        (src/ui.ts)        panels, tuner, event cards, log
      ├──▶ Timeline  (src/timeline.ts)  the <canvas>
      └──▶ Metronome (src/metronome.ts) Web Audio clock → BeatGrid
```

| file | responsibility |
|---|---|
| `index.html` | **All** markup. Static skeleton; nothing generates it. |
| `src/main.ts` | `App`: reads URL settings, constructs the source, funnels every error to one place, owns `Timebase` (library clock → wall clock). |
| `src/ui.ts` | `Ui`: imperative DOM controller. Owns `STATE_COPY` / `ERROR_COPY`. |
| `src/timeline.ts` | `Timeline`: the scrolling canvas. Its own rAF loop. |
| `src/theme.ts` | `readTheme()` — bridges CSS custom properties into the canvas. |
| `src/metronome.ts` | Lookahead Web Audio scheduler. No DOM. |
| `src/mock-tuninator.ts` | Deterministic synthetic source implementing the same interface. No DOM. |
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
When adding a field to the library's frame types, add it to `mock-tuninator.ts` too or the default
demo goes blank where the real one does not.

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
| `?failWith=<TuninatorErrorCode>` | make the mock's `start()` fail with that code |
| `?workletUrl=/nope.js` | exercise `worklet-load-failed` |
| `?shim=silent-ch0\|comb` | smoke-suite-only synthetic `getUserMedia` streams |

---

## Deployment

`.github/workflows/deploy-pages.yml` builds and publishes to GitHub Pages on push to `main`, plus
`workflow_dispatch`. **There is no `pull_request` trigger** — a PR against this repo shows no checks,
which is expected, not a stuck build. Local `npm run smoke:live` is the evidence for a PR.

`LIBRARY_REF` pins which library revision CI builds against. It tracks `main` deliberately: pinning
to a feature branch works right up until that branch is deleted by a merge, and then fails opaquely.

### Known benign build output

Vite logs `new URL("./tuninator-worklet.js", import.meta.url) doesn't exist at build time`. This is a
plain log line, not a run annotation. It comes from the *library's* `resolveWorkletUrl` fallback, and
the demo always passes an explicit `workletUrl`, so it is a branch this build never takes. Fixing it
properly requires a change in the library repo, not here.
