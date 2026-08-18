---
name: cyberpunk-ui
description: Restyle a UI into retro-cyberpunk — near-black grounds, saturated neon accents, monospace/pixel terminal type with glow, technical grids, chamfered HUD panels, glitch, and control-panel navigation — with contrast, focus and reduced-motion guardrails. Use whenever someone asks for a cyberpunk, retro-futurist, retro-dystopian, terminal, CRT, hacker, HUD, neon or Blade-Runner look, or asks to apply that aesthetic to an existing app's CSS, canvas, charts or components. Trigger on informal phrasings too — "make it look like an old computer", "give it that 90s hacker feel", "darker with neon", "make this look like a spaceship console" — and whenever a restyle names neon-on-black. Also use when auditing whether an existing cyberpunk skin is accessible or overdone.
---

# Cyberpunk UI

Turn an interface into retro-cyberpunk without turning it into a toy.

**Source:** every rule in `references/video-guideline.md` is transcribed verbatim from
["The ONLY Guide to Cyberpunk UI Design"](https://www.youtube.com/watch?v=yLdJh2_-o8U). That file is
the spec. Read it when you need the exact wording or the exact hexes; everything here is how to
execute it. Where this file adds something the video did not say — accessibility, motion, testing —
it says so.

## The one rule: restraint plus density

Cyberpunk fails in one specific way, and it is always the same way: **everything glows.** Every
border neon, every label magenta, three accent hues fighting in one panel. The result reads as a
Halloween store, not a control room.

The corrective is a ratio. Roughly **90% of the frame is near-black and neutral; ~10% carries neon**,
and glow is reserved for what is *live* or *actionable*. The source video's own slides are the worked
example: plain white monospace body copy on near-black, and exactly one glowing neon heading per
screen. Dense is good — cyberpunk interfaces are information-thick. *Loud* is not the same as dense.

If you only remember one thing: **neon is the state layer, never the text layer.**

## Workflow

### Step 0 — inventory every colour sink before editing anything

Restyles fail on the colour you forgot, not the colour you chose. A canvas or a chart theme still
painting the old palette is the single most common broken result. Enumerate first:

```bash
rg -n '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' --glob '!node_modules' --glob '!*.min.*'
```

Sweep JS/TS/JSX/SVG/HTML too, not just stylesheets. The sinks people miss:

- canvas 2D `fillStyle` / `strokeStyle` / `shadowColor`, and font strings built by hand
- chart library theme objects (Chart.js, ECharts, Recharts `<Cell fill>`, d3 scales)
- inline `style=` attributes and SVG `fill` / `stroke`
- `<meta name="theme-color">`, favicon data-URIs, `color-scheme`, `::selection`, `accent-color`
- scrollbar colours, print stylesheets, email templates
- **error and fallback paths** — the `catch` branch that hand-writes `style.cssText` when the app
  fails to boot. It cannot use `var(--…)` (the stylesheet may never have applied), so it needs a
  literal — but keep that literal on-palette and say why in a comment.
- **white/black highlight literals** — `rgba(255,255,255,.55)` caps and dividers read as "not really
  a colour" and get skipped. They are still part of the design; give them a token.

Write the list down before you touch a file. You will use it as the completion check in Step 8.

### Step 1 — revalue the token layer, do not rewrite components

If the project already has design tokens, **keep every token name and change only its value.**
A stylesheet that routes colour through `--accent` / `--good` / `--bad` needs one edited block, not
six hundred edited lines, and no state selector can break in the process. Then re-point the literals
Step 0 found at those tokens.

If there are no tokens, create them first (copy `assets/tokens.css`) and migrate the literals into
them. Do not start hand-placing neon on components — that is how the 90/10 ratio gets lost.

### Step 2 — assign palette roles

Pick from the video's palette (§ Palette). Two accents maximum, plus status hues. More than two
competing accents is the rainbow failure. Map to semantic roles, never to components:

`--accent` primary interactive · `--accent-2` secondary/active · `--good` / `--near` / `--bad` status.

### Step 3 — typography

Mono-first. A blocky/pixel display face for headings and hero readouts, a readable mono for
everything else. Uppercase with wide tracking on labels; `font-variant-numeric: tabular-nums` on
anything that updates live, so readouts stop jittering.

### Step 4 — geometry

`border-radius` goes to `0`. The cyberpunk corner is a **45° chamfer**, not a round. Pick the
technique by whether the element takes focus — see § Geometry, this is the part that most often
ships broken.

### Step 5 — texture

One global overlay for grid/scanlines/grain. Never per-component: stacking translucent overlays on
nested elements compounds into mud and costs real paint time.

### Step 6 — glow

Only on the state layer. Glow is `0 0 Npx` in a colour — zero offset. A soft offset drop shadow
(`0 8px 24px rgba(0,0,0,.4)`) is the material-design idiom and reads instantly as the wrong genre.

### Step 7 — motion, with the reduced-motion contract

Glitch and flicker are decoration. Gate them. See § Motion for the contract — the nuance that
matters is that reduced-motion removes *decoration*, not *data*.

### Step 8 — verify

Walk § Verification checklist. Run `scripts/contrast-audit.mjs` against the finished stylesheet.
Re-run the Step 0 grep and confirm the only literals left are the token definitions themselves.

## Palette

The video's exact values. Background `#000000`; primaries `#00FF00` `#00FFFF` `#FF00FF`; secondaries
`#FFD700` `#FF4500`. Its four stated families are neon greens & blues, bright purples & pinks,
fluorescent yellows & reds, and black/very-dark grounds.

| role | value | contrast on `#000` | use for |
|---|---|---|---|
| ground | `#000000` | — | page |
| raised / sunken | `#0A0A0A` / `#050505` | — | panels, wells |
| body text | `#E6E6E6` | 16.8:1 | all prose and data — **not neon** |
| muted text | `#8A8A8A` | 6.1:1 | secondary labels |
| cyan (primary) | `#00FFFF` | 16.8:1 | links, focus, primary action |
| magenta (secondary) | `#FF00FF` | 6.7:1 | active state, accents |
| green (status ok) | `#00FF00` | 15.3:1 | healthy, in-tune, live |
| gold (status warn) | `#FFD700` | 15.0:1 | near, pending, mock |
| orange-red (status bad) | `#FF4500` | 6.1:1 | errors, out-of-range |
| violet (extension) | `#B967FF` | 6.5:1 | a 4th category when needed |

All of these clear WCAG AA on pure black, so the palette is usable as specified — a genuinely
convenient property of neon-on-black that this genre gets for free. Two cautions the ratios hide:

- **Magenta, orange-red and violet cluster at 6.1–6.7:1** — comfortably AA, short of AAA. Fine for
  body-size text and graphics; for thin 10–11px labels prefer cyan, green, gold or plain `--text`,
  or the `--bad-text` / `--violet-text` variants in `assets/tokens.css`.
- **Saturated blue-on-black fringes** on LCDs. Prefer cyan over pure `#0000FF` for anything textual.

Never use hue as the *only* carrier of state — pair it with a glyph, label or position. Colour-blind
users aside, on a glowing dark UI the hues bloom into each other at small sizes.

## Typography

The video names **Roboto Mono, VT323, or custom pixel art fonts**, plus a **glowing effect**, and
describes the target as "blocky, tech-like, or pixelated."

Pair a display face with a text face: VT323 (or another pixel face) for `h1`, panel titles and hero
readouts; Roboto Mono for body, data, logs and controls. Self-host — `@fontsource/vt323`,
`@fontsource/roboto-mono` — rather than hotlinking Google Fonts, so the build stays offline-safe and
screenshot tests stay deterministic. Always give a real fallback stack ending in `monospace`.

Glow belongs on headings and live values only:

```css
--glow-1: 0 0 4px  color-mix(in srgb, currentColor 70%, transparent);
--glow-2: 0 0 12px color-mix(in srgb, currentColor 45%, transparent);
/* h1, hero readouts, live badges: */
text-shadow: var(--glow-1), var(--glow-2);
```

Glowing body copy is the fastest way to make an interface unreadable. Don't.

Pixel display faces (VT323 and friends) have no real small-caps, so `font-variant-caps` synthesises
them — and synthesised small-caps at 18-20px, under a glow and a scanline overlay, turns to mush.
Error text is exactly where that hurts most. For the few strings that *must* stay readable, keep
sentence case and gain the emphasis from size instead.

**Uppercase has a testing trap.** `text-transform: uppercase` changes what `innerText` returns in the
DOM, so any test asserting on rendered text (Playwright's `innerText()`, Testing Library's
`getByText`) starts failing on strings it used to match. `font-variant-caps: all-small-caps` renders
as caps without touching the text, and browsers synthesise it when the font lacks the feature. Use
`text-transform` freely on decorative labels; reach for `font-variant-caps` on anything a test reads.

## Geometry

Rule 3 asks for *grids and geometric patterns, hexagonal and circular shapes, glitch effects*.

**Chamfers.** Three techniques, and the choice is driven by focusability:

| technique | keeps focus ring? | keeps outer glow? | draws a line on the diagonal? | use on |
|---|---|---|---|---|
| `clip-path: polygon(...)` | ✗ clipped | ✗ clipped | ✗ | non-focusable decoration only |
| gradient corner-cut | ✓ | ✓ | ✓ | buttons, selects, panels |
| corner brackets (pseudo-elements) | ✓ | ✓ | n/a — frames instead of cuts | panels, cards |

`clip-path` is the obvious first reach and it silently eats both the focus outline and any outer
`box-shadow`. Restrict it to badges, pills and chips that never take focus. For anything interactive
use the gradient cut, which keeps the real border:

```css
.cut-br {
  border: 1px solid var(--line);
  background-color: var(--bg-raised);
  background-image: linear-gradient(-45deg,
    var(--bg) 0 calc(var(--cut) - 1.5px),
    var(--line) calc(var(--cut) - 1.5px) var(--cut),
    transparent var(--cut));
  background-repeat: no-repeat;
  background-position: bottom right;
  background-size: var(--cut) var(--cut);
}
```

It paints the cut-away corner in the *parent's* colour, so it only works over a known ground — true
for almost every panel, false inside arbitrary scroll containers.

**Grids, hexes, brackets, glitch** — recipes in `references/recipes.md`.

## Navigation and interactivity

Rules 4 and 5: *guide users like a futuristic "control panel," with clearly defined sections and
intuitive navigation* — buttons with techy aesthetics, a navigation panel — and *hover and focus
effects to make the user feel like they are interacting with an advanced system*, with hover effects
and progressive disclosure.

This is the half of the brief that is about **behaviour**, and it is the half people skip. A dark
neon skin with default browser focus rings and no hover feedback has not followed this video.

- **Clearly defined sections.** Give every region a visible frame and a labelled header. Section
  indices (`[01] TIMELINE`) and `SYS//` prefixes are the idiom, and they genuinely help scanning.
- **Techy buttons.** Chamfered, tracked caps, bracketed labels, border and glow intensifying on hover.
- **Focus.** Most restyles ship with none. Add an explicit `:focus-visible` ring in the primary
  accent — it satisfies rule 5 *and* it is the accessibility floor. If an element uses `clip-path`,
  swap `outline` for `box-shadow: inset 0 0 0 2px var(--focus)`, which survives clipping.
- **Progressive disclosure.** Reveal *detail* on hover/focus — metadata rows, secondary readouts,
  hints. Never hide anything a user needs to complete the task; density is the aesthetic, so the
  disclosure should uncover a third layer, not restore a missing first one.

## Motion

Glitch is a named rule; scanline flicker is not (see `references/video-guideline.md`). Both are
decoration, and decoration is gated:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
  }
}
```

**Reduced motion removes decoration, not data.** A scrolling waveform, a moving needle, a live chart
are information — they keep running. A flickering overlay, a glitching title, a pulsing border are
decoration — they stop. A blanket CSS reset like the one above gets this right automatically, because
data animations driven by `requestAnimationFrame` are untouched by it. Don't "helpfully" pause them.

Two more: keep flicker amplitude under ~15% opacity or it reads as a broken monitor rather than a CRT,
and animate the *overlay's* opacity rather than a wrapper around the whole app — animating opacity on
a container forces the entire subtree to recomposite every frame.

Prefer a **static** RGB-split for glitch where you can (twin offset `text-shadow` in two hues). It
needs no markup, no animation, survives reduced-motion untouched, and is stable in screenshot tests.

## Anti-patterns

- Light or mid-grey grounds. The palette only works against near-black.
- Desaturated, "tasteful" accents. Muted neon is just a dark theme.
- Soft offset drop shadows. Glow is coloured, zero-offset, `0 0 Npx`.
- `border-radius > 4px`. Round corners are the opposite idiom.
- Neon body copy, or glow on everything — the 90/10 ratio, violated.
- Three or more competing accent hues in one view.
- Centred, airy, generously-spaced layouts. Cyberpunk is dense and rectilinear.
- The modern-synthwave slide: purple-pink gradient sunsets, chrome portraits. The source video
  explicitly positions *against* this; aim at a 1997 terminal, not a 2019 album cover.

## Verification checklist

1. `scripts/contrast-audit.mjs <stylesheet>` passes — no text token under 4.5:1 on its ground.
2. Re-run the Step 0 grep; the only colour literals left are the token definitions.
3. Squint at a screenshot. If more than ~10% of the frame glows, pull glow off the least
   valuable elements until it doesn't.
4. Tab through. Every interactive element shows a visible focus ring, including chamfered ones.
5. Toggle `prefers-reduced-motion: reduce`. Decoration stops; live data keeps moving.
6. Check the smallest text in the design (10–12px labels) — legible, and not in a 5–7:1 hue.
7. Run the project's own tests. Watch specifically for text assertions broken by
   `text-transform` (§ Typography) and for pixel/colour assertions broken by the new ground.
   Check that colour-sampling tests did not merely *pass* but stayed **meaningful**: a test that
   counts "pixels different from `#0d1117`" still passes against a black ground — it just reports
   ~100% and now asserts nothing. Re-point such probes at the token
   (`getComputedStyle(root).getPropertyValue("--bg")`) rather than a hardcoded triple. A check that
   silently went vacuous is worse than one that failed loudly.
8. Confirm non-CSS surfaces repainted: canvas, charts, SVG, favicon, `theme-color`.

## Adapting to the stack

`assets/tokens.css` is plain custom properties and drops into any stack. `assets/tokens.json` is the
same values for Tailwind presets and JS consumers. Framework-specific traps — Tailwind arbitrary
values escaping the theme, CSS-in-JS duplication, canvas and chart theming, SVG — are in
`references/porting.md`. The single-source-of-truth pattern for canvas is there too, and it matters:
have the canvas *read* the CSS custom properties at runtime rather than keeping a parallel palette in
JS, or the two will drift the first time someone tweaks a token.
