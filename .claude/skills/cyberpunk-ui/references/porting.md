# Porting to a stack

`SKILL.md`'s workflow is stack-agnostic; the traps are not. Find your stack below.

Contents: [Plain CSS](#plain-css--sass--css-modules) · [Tailwind](#tailwind) ·
[CSS-in-JS / React](#css-in-js-and-react) · [Canvas](#canvas) · [Charts](#charts) ·
[SVG & icons](#svg-and-icons) · [Non-obvious sinks](#non-obvious-sinks)

---

## Plain CSS / Sass / CSS Modules

The happy path. Copy `../assets/tokens.css` into the entry stylesheet, or — better — if the project
already has a `:root` token block, **revalue its existing tokens in place and keep their names.**
A stylesheet whose components all say `var(--accent)` restyles completely from one edited block, and
no component selector or state rule can break in the process.

Sass variables compiled at build time cannot be revalued at runtime and do not inherit through
`currentColor`. If the project uses `$accent: #58a6ff`, redefine the Sass variable to
`var(--accent)` and put the real value in CSS custom properties, so the glow tokens
(`color-mix(... currentColor ...)`) work.

## Tailwind

Two things to do, and one big trap.

**Wire the tokens into the theme** so utilities generate from them:

```js
// tailwind.config.js
const t = require("./.claude/skills/cyberpunk-ui/assets/tokens.json");
module.exports = {
  theme: {
    extend: {
      colors: {
        bg: t.color.bg, "bg-raised": t.color.bgRaised, "bg-sunken": t.color.bgSunken,
        accent: t.color.accent, "accent-2": t.color.accent2,
        good: t.color.good, near: t.color.near, bad: t.color.bad, violet: t.color.violet,
      },
      fontFamily: { mono: [t.font.mono], display: [t.font.display] },
      borderRadius: { DEFAULT: "0", none: "0" },
      boxShadow: { glow: t.boxShadow.glow2, "glow-lg": t.boxShadow.glow3 },
    },
  },
};
```

**The trap: arbitrary values escape the theme entirely.** `bg-[#0d1117]`, `text-[#58a6ff]`,
`shadow-[0_8px_24px_rgba(0,0,0,.4)]` are invisible to any theme change. Grep for them explicitly —
they are the Tailwind equivalent of the hardcoded literals in Step 0:

```bash
rg -n '\[#[0-9a-fA-F]{3,8}\]|\[rgba?\(' --glob '*.{tsx,jsx,ts,js,html,vue,svelte}'
```

Also sweep `rounded-*` → `rounded-none`, and `shadow-md|lg|xl` → your glow utility, since Tailwind's
default shadows are exactly the offset drop shadows `SKILL.md` warns against.

For chamfers, add a small plugin utility rather than repeating `clip-path` arbitrary values:

```js
plugin(({ addUtilities }) => addUtilities({
  ".cut": { clipPath: "polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)" },
}))
```

## CSS-in-JS and React

Keep the tokens in a **global stylesheet**, not a JS theme object, and have components read
`var(--accent)`. Two reasons: `color-mix(in srgb, currentColor ...)` only works if the value is
resolved by CSS at the use site, and a duplicated JS palette is guaranteed to drift.

If a build genuinely needs JS-side values (a chart library that will not take CSS variables, a
canvas), generate them from `assets/tokens.json` rather than retyping hexes.

```js
// one source of truth, read once at runtime
const css = getComputedStyle(document.documentElement);
const accent = css.getPropertyValue("--accent").trim();
```

styled-components / emotion: `styled.div\`color: var(--accent);\`` is correct. A `ThemeProvider`
holding hexes is the thing that drifts.

## Canvas

Canvas is where restyles most often end up half-done, because nothing about a `<canvas>` inherits
from CSS. Do not maintain a parallel palette in the drawing code. Read the tokens:

```ts
export type CanvasTheme = { ground: string; grid: string; accent: string; fontMono: string };

export function readTheme(el: Element = document.documentElement): CanvasTheme {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  return {
    ground:   v("--canvas-ground", "#000000"),
    grid:     v("--canvas-grid", "rgba(0,255,255,0.10)"),
    accent:   v("--accent", "#00ffff"),
    fontMono: v("--font-mono", "ui-monospace, monospace"),
  };
}
```

Always supply fallbacks — a missing variable returns `""`, and `ctx.fillStyle = ""` silently keeps
the *previous* colour, which produces a canvas that is subtly wrong rather than obviously broken.

Read once and cache; `getComputedStyle` in a 60fps draw loop is a layout-thrash hazard. Re-read on
resize or on an explicit theme change, not per frame.

Three more canvas notes:

- **Font strings must be rebuilt**, not just recoloured — `ctx.font = "11px " + theme.fontMono`.
  Duplicated literal font stacks are easy to miss because they aren't colours.
- **`ctx.shadowBlur` is genuinely expensive** at 60fps and 2× DPR. Use it on the few elements that
  need to glow (the ones near a playhead, the selected series), not every shape.
- **Categorical hue ramps need constraining, not replacing.** If code maps a category index across
  the full 360° wheel, it will emit greens and oranges that are outside the palette. Narrow it to an
  arc — e.g. cyan 176° → magenta 332° — keeping the encoding intact. Collapsing everything to one
  hue destroys the encoding (and breaks any test counting distinct colours).

## Charts

Chart libraries hold their own defaults. Set the theme object from the tokens once, globally:

- **Chart.js** — `Chart.defaults.color`, `.borderColor`, `.font.family`; per-dataset
  `borderColor` / `backgroundColor`.
- **ECharts** — register a theme via `echarts.registerTheme`, or pass `textStyle` + `color[]`.
- **Recharts** — no theme layer; every `<Cell fill>`, `<Line stroke>`, axis `tick.fill` is set per
  component. Grep for `fill=` and `stroke=` in JSX.
- **d3** — replace `d3.schemeCategory10` with a palette-constrained ramp; grid/axis colours are set
  by CSS on `.tick line` and `.domain`, so those *can* be tokenised.

Grid lines and axis labels want `--text-muted` and a low-alpha `--accent`, not the library's default
mid-grey — the default reads as washed-out on near-black.

## SVG and icons

Inline SVG inherits `currentColor`, so `fill="currentColor"` is the goal. Hardcoded `fill="#58a6ff"`
in an icon sprite is invisible to the token layer. For a sprite you cannot edit, `filter: hue-rotate()`
is a last resort; replacing the fills is better.

Favicons are usually forgotten. An inline data-URI favicon has its colours URL-encoded
(`%23` is `#`), so a plain grep for `#0d1117` will not find `%230d1117`. Search for both.

## Non-obvious sinks

The full checklist for Step 0, beyond stylesheets and components:

| sink | how to find it |
|---|---|
| canvas 2D | `fillStyle`, `strokeStyle`, `shadowColor`, `ctx.font` |
| chart themes | library defaults object, per-series props |
| inline styles | `style="` in HTML, `style={{` in JSX |
| SVG | `fill=`, `stroke=`, `stop-color=` |
| favicon | data-URI with `%23` encoding, or `.ico`/`.svg` in `public/` |
| browser chrome | `<meta name="theme-color">`, `color-scheme`, `accent-color` |
| selection | `::selection`, `::-moz-selection` |
| scrollbars | `scrollbar-color`, `::-webkit-scrollbar-*` |
| form controls | `accent-color` on checkboxes/radios/range |
| screenshot tests | hardcoded expected pixel values (see `SKILL.md § Verification`) |
| print | `@media print` blocks, which usually assume a white ground |
