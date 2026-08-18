# Recipes

Copy-paste CSS for the effects `SKILL.md` calls for. Every recipe is dependency-free and assumes the
tokens in `../assets/tokens.css`.

Contents: [Grid](#technical-grid) · [Scanlines & grain](#scanlines-and-grain) ·
[Chamfers](#chamfers) · [HUD brackets](#hud-corner-brackets) · [Hexagons](#hexagons-and-circles) ·
[Glitch](#glitch) · [Glow](#glow) · [Techy buttons](#techy-buttons) ·
[Progressive disclosure](#progressive-disclosure) · [Terminal details](#terminal-details)

---

## Technical grid

Rule 3's "grids and geometric patterns". Put it on the page ground, not on components.

```css
body {
  background-color: var(--bg);
  background-image:
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
  background-size: var(--grid-pitch) var(--grid-pitch);
}
```

Keep `--grid-line` around 4% alpha. At higher alpha it stops reading as substrate and starts
competing with content. A second, coarser grid at 4× the pitch and slightly higher alpha reads as
"major/minor gridlines" and is worth it on large empty areas.

## Scanlines and grain

**Not a video rule** — retro-dystopian extension. One overlay element, once, at page level.

```html
<div class="fx" aria-hidden="true"></div>
```

```css
body { position: relative; }

.fx {
  position: absolute;   /* NOT fixed — see the note below */
  inset: 0;
  pointer-events: none;
  z-index: 50;
}

.fx::before {           /* scanlines */
  content: "";
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(0deg,
    var(--scanline) 0 1px, transparent 1px 3px);
}

.fx::after {            /* grain */
  content: "";
  position: absolute;
  inset: 0;
  opacity: 0.05;
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 120px 120px;
}
```

Two traps:

- **`position: fixed` breaks full-page screenshots.** A fixed overlay covers one viewport band; a
  full-page capture of a long document shows the effect only in the top screenful. `absolute` inside
  a `position: relative` body spans the whole document, because the containing block is body's
  padding box and grows with content.
- **Give the noise SVG explicit `width`/`height` and tile it.** An untiled `feTurbulence` stretched
  over a full page at 2× DPR is a genuinely expensive rasterisation.

Check the result over any canvas or dense table at 2× DPR — 1px scanlines can moiré against
regular content. If they do, drop `--scanline` alpha or widen the period to 4px.

## Chamfers

See `SKILL.md § Geometry` for which technique to use where. All three, concretely:

```css
/* A. clip-path — non-focusable decoration ONLY (clips outline + outer glow) */
.chip {
  clip-path: polygon(
    var(--cut-sm) 0, 100% 0,
    100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%,
    0 100%, 0 var(--cut-sm));
}

/* B. gradient corner-cut — interactive elements; keeps border, outline, glow */
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

/* C. focus ring that survives technique A */
.chip:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--focus);
}
```

Technique B paints the cut corner in `var(--bg)`, so the element must sit on that ground. Over an
unknown or image background, fall back to A plus C.

## HUD corner brackets

Frames a panel without clipping anything. No markup, no extra elements.

```css
.panel { position: relative; }

.panel::before,
.panel::after {
  content: "";
  position: absolute;
  width: 12px;
  height: 12px;
  pointer-events: none;
  border-color: var(--accent);
  border-style: solid;
}
.panel::before { top: -1px; left: -1px;     border-width: 1px 0 0 1px; }
.panel::after  { bottom: -1px; right: -1px; border-width: 0 1px 1px 0; }
```

Only two corners, because an element has only two pseudo-elements — and diagonal pairs read better
than four anyway. For all four, add an inner wrapper or use a `border-image`.

## Hexagons and circles

Rule 3 names both. Circles are easy (`border-radius: 50%` is allowed here — it's a circle, not a
rounded rectangle). Hexagons:

```css
.hex {
  clip-path: polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%);
}

/* hex bullet for a definition list or nav item */
.meters dt::before {
  content: "";
  display: inline-block;
  width: 7px; height: 8px;
  margin-right: 6px;
  background: var(--accent);
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
}
```

## Glitch

**Static RGB split** — preferred. No markup, no animation, reduced-motion-safe, screenshot-stable:

```css
h1 {
  text-shadow:
     1.5px 0 0 color-mix(in srgb, var(--accent-2) 65%, transparent),
    -1.5px 0 0 color-mix(in srgb, var(--accent) 65%, transparent);
}
```

**Animated** — opt-in, and gate it. The `attr()` twin-pseudo version needs a `data-text` duplicate of
the string, which also lands in the accessibility tree; add `aria-hidden` to the pseudo source or
prefer the clip-based version:

```css
@keyframes glitch-shift {
  0%, 92%, 100% { transform: none; clip-path: none; }
  93% { transform: translateX(-2px); clip-path: inset(20% 0 60% 0); }
  95% { transform: translateX(2px);  clip-path: inset(65% 0 15% 0); }
  97% { transform: translateX(-1px); clip-path: inset(40% 0 40% 0); }
}
.glitch:hover { animation: glitch-shift 1.6s steps(1) infinite; }
```

Long quiet stretches with brief bursts (as above) read as a failing signal. Continuous jitter reads
as a broken stylesheet.

## Glow

```css
/* on the state layer only */
.is-live {
  color: var(--good);
  text-shadow: var(--glow-1), var(--glow-2);
}
.panel--active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent),
              0 0 18px color-mix(in srgb, var(--accent) 18%, transparent);
}
```

`currentColor` inside `color-mix` inside a custom property resolves at the use site, so a single
`--glow-1` token automatically tints itself to whatever colour the element already is. That is why
the tokens are written that way — one token, every hue.

## Techy buttons

```css
.btn {
  border: 1px solid var(--line);
  background: var(--bg-raised);
  color: var(--text);
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.09em;
  padding: 8px 14px;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease, box-shadow .12s ease;
}
.btn::before { content: "[ "; color: var(--accent); }
.btn::after  { content: " ]"; color: var(--accent); }

.btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--bg-raised));
  box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 22%, transparent);
}

:where(button, select, input, a, [tabindex]):focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
```

Bracket pseudo-elements are decorative and are announced by some screen readers as punctuation. If
that matters, move them to `::before`/`::after` on a `<span>` inside, or accept it — most readers
skip lone brackets.

## Progressive disclosure

Reveal a third layer of detail; never restore a missing first layer.

```css
.event-card .event-meta {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition: max-height .18s ease, opacity .18s ease;
}
.event-card:hover .event-meta,
.event-card:focus-within .event-meta {
  max-height: 12em;
  opacity: 1;
}
```

`:focus-within` alongside `:hover` is what makes this keyboard-reachable — without it the detail is
mouse-only. If the hidden content contains focusable elements, use `content-visibility` or
`visibility` rather than `max-height`, so it is properly removed from the tab order when collapsed.

## Terminal details

Cheap, high-return texture that costs no images:

```css
/* box-drawing gutter on log lines */
.log-line::before {
  content: "│";
  color: color-mix(in srgb, var(--accent) 30%, transparent);
  margin-right: 6px;
}

/* section index on panel headings */
.panel-head h2::before {
  content: "// ";
  color: var(--accent);
  opacity: .55;
}

/* square terminal scrollbars */
.scroll-pane {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--accent) 40%, transparent) var(--bg-sunken);
}
.scroll-pane::-webkit-scrollbar { width: 8px; height: 8px; }
.scroll-pane::-webkit-scrollbar-track { background: var(--bg-sunken); }
.scroll-pane::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--accent) 34%, transparent);
  border-radius: 0;
}

/* blinking caret after a live status string */
.caret::after {
  content: "▋";
  color: var(--accent);
  animation: caret-blink 1.1s steps(1) infinite;
}
@keyframes caret-blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
```

Pseudo-element `content` is read aloud by most screen readers. Decorative glyphs like `│` and `▋`
should carry `aria-hidden` on their host element where the host is purely decorative, or be paired
with real text that already conveys the meaning.
